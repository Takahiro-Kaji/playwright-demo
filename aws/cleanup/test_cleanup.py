import importlib.util
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('cleanup',Path(__file__).with_name('cleanup.py'))
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)

class CleanupTests(unittest.TestCase):
    def test_requires_distinct_initialized_states(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d,'.terraform').mkdir(); var=Path(d,'x.tfvars'); var.touch()
            base={'directory':d,'workspace':'w','var_file':str(var)}
            config={'account':'123456789012','regions':['a','b'],'contexts':{'a':'ca','b':'cb'},'states':[dict(base,kind='infra'),dict(base,kind='sso',region='a'),dict(base,kind='sso',region='b')]}
            with self.assertRaises(c.CleanupError): c.validate_config(config)
            config['states'][1]['workspace']='sso-a';config['states'][2]['workspace']='sso-b'
            c.validate_config(config)

    def test_changed_state_stops_before_any_deletion(self):
        snapshot={'states':[{'digest':'before'}]}
        with patch.object(c,'identity'), patch.object(c,'state_details',return_value={'digest':'after'}), patch.object(c,'delete_ingress') as delete:
            with self.assertRaises(c.CleanupError): c.destroy(snapshot)
            delete.assert_not_called()

    def test_load_balancer_blocks_terraform_destroy(self):
        s={'kind':'infra','digest':'a','directory':'/x','workspace':'w','var_file':'/v'}
        snapshot={'regions':['a','b'],'states':[s], 'vpcs':[{'region':'a','vpc':'vpc-1','load_balancers':['lb-1'],'target_groups':[]}]}
        with patch.object(c,'identity'), patch.object(c,'state_details',return_value={'digest':'a'}), patch.object(c,'cluster_context'), patch.object(c,'delete_ingress'), patch.object(c,'collect_vpc',return_value={'load_balancers':['lb-1'],'target_groups':[]}), patch.object(c,'destroy_state') as run:
            with self.assertRaises(c.CleanupError): c.destroy(snapshot)
            run.assert_not_called()

    def test_never_treat_command_failure_as_empty(self):
        with patch.object(c.subprocess,'run',return_value=type('Result',(),{'returncode':1,'stderr':'access denied'})()):
            with self.assertRaises(c.CleanupError): c.aws('a','ec2','describe-volumes')

    def test_new_load_balancer_or_target_group_blocks_destroy(self):
        state={'kind':'infra','digest':'a','directory':'/x','workspace':'w','var_file':'/v'}
        snapshot={'regions':['a','b'],'states':[state], 'vpcs':[{'region':'a','vpc':'vpc-1','load_balancers':[],'target_groups':[]}]}
        for remaining in ({'load_balancers':['new-lb'],'target_groups':[]},
                          {'load_balancers':[],'target_groups':['new-tg']}):
            with self.subTest(remaining=remaining), patch.object(c,'identity'), patch.object(c,'state_details',return_value={'digest':'a'}), patch.object(c,'cluster_context'), patch.object(c,'delete_ingress'), patch.object(c,'collect_vpc',return_value=remaining), patch.object(c,'destroy_state') as run:
                with self.assertRaises(c.CleanupError): c.destroy(snapshot)
                run.assert_not_called()

    def test_empty_current_load_balancers_allow_destroy(self):
        state={'kind':'infra','digest':'a','directory':'/x','workspace':'w','var_file':'/v'}
        snapshot={'regions':['a','b'],'states':[state], 'vpcs':[{'region':'a','vpc':'vpc-1','load_balancers':['old-lb'],'target_groups':['old-tg']}]}
        with patch.object(c,'identity'), patch.object(c,'state_details',return_value={'digest':'a'}), patch.object(c,'cluster_context'), patch.object(c,'delete_ingress'), patch.object(c,'collect_vpc',return_value={'load_balancers':[],'target_groups':[]}), patch.object(c,'destroy_state') as run:
            c.destroy(snapshot)
            run.assert_called_once()

    def test_verify_reports_retained_disk_and_missing_inventory(self):
        snapshot={'regions':['a','b'], 'states':[{'kind':'infra','not_started':True,'resources':[]}], 'vpcs':[{'region':'a','vpc':'vpc-1','instances':[],'volumes':['vol-1'],'eips':[],'load_balancers':[],'target_groups':[],'nat_gateways':[]}]}
        responses={
            ('iam','list-roles'):{'Roles':[]},
            ('ec2','describe-instances'):{'Reservations':[]},
            ('ec2','describe-volumes'):{'Volumes':[{'VolumeId':'vol-1'}]},
            ('ec2','describe-addresses'):{'Addresses':[]},
            ('elbv2','describe-load-balancers'):{'LoadBalancers':[]},
            ('elbv2','describe-target-groups'):{'TargetGroups':[]},
            ('ec2','describe-nat-gateways'):{'NatGateways':[]},
            ('ec2','describe-vpcs'):{'Vpcs':[]},
            ('rds','describe-db-instances'):{'DBInstances':[]},
            ('ecr','describe-repositories'):{'repositories':[]},
            ('eks','list-clusters'):{'clusters':[]},
            ('cognito-idp','list-user-pools'):{'UserPools':[]},
        }
        with patch.object(c,'identity'), patch.object(c,'aws',side_effect=lambda region,*args: responses[args[:2]]):
            findings=c.verify(snapshot)
        self.assertTrue(any('vol-1' in item for item in findings))
        self.assertTrue(any('UNCONFIRMED' in item for item in findings))

    def test_context_checks_certificate_authority(self):
        snapshot={'account':'123456789012','regions':['a','b'],'contexts':{'a':'ctx'}, 'states':[{'kind':'infra','resources':[{'address':'aws_eks_cluster.demo','id':'cluster','arn':'arn:aws:eks:a:123456789012:cluster/cluster'}]}]}
        remote={'cluster':{'arn':'arn:aws:eks:a:123456789012:cluster/cluster','endpoint':'https://endpoint','certificateAuthority':{'data':'real'}}}
        kube='{"clusters":[{"cluster":{"server":"https://endpoint","certificate-authority-data":"other"}}]}'
        with patch.object(c,'aws',return_value=remote), patch.object(c,'run',return_value=kube):
            with self.assertRaises(c.CleanupError): c.cluster_context(snapshot,'a')

    def test_external_command_failure_does_not_expose_secrets(self):
        secret='dummy-auth-token-DO-NOT-LOG'
        result=subprocess.CompletedProcess(['kubectl'],1,stdout=secret,stderr=secret)
        with patch.object(c.subprocess,'run',return_value=result):
            with self.assertRaises(c.CleanupError) as error:
                c.run(['kubectl',secret])
        self.assertNotIn(secret,str(error.exception))

    def test_destroy_plan_is_reviewed_and_failures_do_not_leak(self):
        entry={'directory':'/x','workspace':'w','var_file':'/v'}
        secret='dummy-auth-token-DO-NOT-LOG'
        output=io.StringIO()
        with patch.object(c,'run',side_effect=['safe plan','']), patch('builtins.input',return_value='yes'), contextlib.redirect_stdout(output):
            c.destroy_state(entry)
        self.assertIn('safe plan',output.getvalue())
        failed=subprocess.CompletedProcess(['terraform'],1,stdout=secret,stderr=secret)
        output=io.StringIO()
        with patch.object(c.subprocess,'run',return_value=failed), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(c.CleanupError) as error: c.destroy_state(entry)
        self.assertNotIn(secret,output.getvalue())
        self.assertNotIn(secret,str(error.exception))

    def test_destroy_preserves_sso_before_infrastructure(self):
        states=[{'kind':kind,'digest':'h','directory':name,'workspace':'w','var_file':'/v'} for kind,name in [('infra','infra'),('sso','sso-a'),('sso','sso-b')]]
        snapshot={'regions':['a','b'],'states':states,'vpcs':[]}
        with patch.object(c,'identity'), patch.object(c,'state_details',return_value={'digest':'h'}), patch.object(c,'cluster_context'), patch.object(c,'delete_ingress'), patch.object(c,'destroy_state') as destroy:
            c.destroy(snapshot)
        self.assertEqual([call.args[0]['directory'] for call in destroy.call_args_list],['sso-a','sso-b','infra'])

    @unittest.skipUnless(shutil.which('kubectl'), 'kubectl is required for this integration test')
    def test_real_kubectl_context_and_fail_closed(self):
        secret='dummy-auth-token-DO-NOT-LOG'
        ca=base64.b64encode(b'dummy CA bytes').decode()
        arn='arn:aws:eks:a:123456789012:cluster/cluster'
        resource={'address':'aws_eks_cluster.demo','id':'cluster','arn':arn}
        infra={'kind':'infra','digest':'hash','directory':'/x','workspace':'w','var_file':'/v','resources':[resource]}
        snapshot={'account':'123456789012','regions':['a','b'],'contexts':{'a':'ctx','b':'other'},'states':[infra],'vpcs':[]}
        remote={'cluster':{'arn':arn,'endpoint':'https://expected.example','certificateAuthority':{'data':ca}}}
        config={'apiVersion':'v1','kind':'Config','current-context':'ctx',
                'clusters':[{'name':'cluster','cluster':{'server':'https://expected.example','certificate-authority-data':ca}}],
                'contexts':[{'name':'ctx','context':{'cluster':'cluster','user':'test-user'}}],
                'users':[{'name':'test-user','user':{'token':secret}}]}
        real_run=subprocess.run
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory,'config')
            def write_config(): path.write_text(json.dumps(config))
            write_config()
            output=io.StringIO()
            with patch.dict(os.environ,{'KUBECONFIG':str(path)}), patch.object(c,'aws',return_value=remote), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                self.assertEqual(c.cluster_context(snapshot,'a'),'ctx')
                for change in ('wrong_ca','wrong_endpoint','missing_ca','insecure','ca_file','command_failure'):
                    with self.subTest(change=change):
                        cluster=config['clusters'][0]['cluster']
                        cluster.clear(); cluster.update({'server':'https://expected.example','certificate-authority-data':ca})
                        if change=='wrong_ca': cluster['certificate-authority-data']=base64.b64encode(b'other').decode()
                        if change=='wrong_endpoint': cluster['server']='https://wrong.example'
                        if change=='missing_ca': cluster.pop('certificate-authority-data')
                        if change=='insecure': cluster['insecure-skip-tls-verify']=True
                        if change=='ca_file':
                            cluster.pop('certificate-authority-data')
                            cluster['certificate-authority']=str(Path(directory,'ca.pem'))
                            Path(directory,'ca.pem').write_bytes(b'dummy CA bytes')
                        write_config()
                        if change=='command_failure': path.write_text('invalid: [')
                        # Run the real kubectl; reject any attempt to start Terraform.
                        def guarded_run(args, **kwargs):
                            if args[0]=='terraform': self.fail('Terraform must not run')
                            return real_run(args, **kwargs)
                        with patch.object(c,'identity'), patch.object(c,'state_details',return_value={'digest':'hash'}), patch.object(c,'delete_ingress') as delete, patch.object(c.subprocess,'run',side_effect=guarded_run):
                            with self.assertRaises(c.CleanupError) as error:
                                c.destroy(snapshot)
                            delete.assert_not_called()
                            self.assertNotIn(secret,str(error.exception))
                            if change in ('wrong_ca','wrong_endpoint','insecure'):
                                self.assertIn('endpoint or CA does not match',str(error.exception))
                            if change in ('missing_ca','ca_file'):
                                self.assertIn('embedded kubeconfig CA data required',str(error.exception))
            self.assertNotIn(secret,output.getvalue())

    def test_unlabelled_ingress_is_not_deleted(self):
        with patch.object(c,'cluster_context',return_value='context'), patch.object(c,'run',return_value='{"metadata":{"labels":{}}}') as run:
            with self.assertRaises(c.CleanupError): c.delete_ingress({},'a')
            self.assertEqual(run.call_count,1)

if __name__=='__main__': unittest.main()
