import importlib.util
from pathlib import Path
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
        with patch.object(c,'identity'), patch.object(c,'state_details',return_value={'digest':'a'}), patch.object(c,'cluster_context'), patch.object(c,'delete_ingress'), patch.object(c,'collect_vpc',return_value={'load_balancers':['lb-1'],'target_groups':[]}), patch.object(c.subprocess,'run') as run:
            with self.assertRaises(c.CleanupError): c.destroy(snapshot)
            run.assert_not_called()

    def test_never_treat_command_failure_as_empty(self):
        with patch.object(c.subprocess,'run',return_value=type('Result',(),{'returncode':1,'stderr':'access denied'})()):
            with self.assertRaises(c.CleanupError): c.aws('a','ec2','describe-volumes')

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

    def test_unlabelled_ingress_is_not_deleted(self):
        with patch.object(c,'cluster_context',return_value='context'), patch.object(c,'run',return_value='{"metadata":{"labels":{}}}') as run:
            with self.assertRaises(c.CleanupError): c.delete_ingress({},'a')
            self.assertEqual(run.call_count,1)

if __name__=='__main__': unittest.main()
