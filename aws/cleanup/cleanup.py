#!/usr/bin/env python3
"""Scoped teardown; inventory contains identifiers, never Terraform state values."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

class CleanupError(Exception): pass

def run(args, env=None):
    result = subprocess.run(args, env=env, text=True, capture_output=True)
    if result.returncode:
        raise CleanupError(f"command failed: {args[0]} {args[1] if len(args)>1 else ''}; {result.stderr.strip()[:400]}")
    return result.stdout

def aws(region, *args):
    return json.loads(run(['aws', '--region', region, '--output', 'json', *args]))

def clean_env():
    return {k:v for k,v in os.environ.items() if k != 'TF_DATA_DIR' and not k.startswith('TF_CLI_ARGS')}

def tf(state, *args):
    env = clean_env()
    env['TF_WORKSPACE'] = state['workspace']
    return run(['terraform', '-chdir='+state['directory'], *args], env)

def state_objects(tree):
    result = list(tree.get('resources', []))
    for child in tree.get('child_modules', []): result.extend(state_objects(child))
    return result

def state_details(state):
    raw = tf(state, 'state', 'pull')
    obj = json.loads(raw)
    show = json.loads(tf(state, 'show', '-json'))
    resources = state_objects(show.get('values', {}).get('root_module', {}))
    # Only identifiers and types are retained. State contains credentials.
    selected = [{'type': r['type'], 'id': r.get('values', {}).get('id'), 'arn': r.get('values', {}).get('arn'), 'address': r['address'], 'name': r.get('values', {}).get('name'), 'identifier': r.get('values', {}).get('identifier')} for r in resources if r.get('mode') == 'managed']
    return {'lineage': obj.get('lineage'), 'serial': obj.get('serial'), 'digest': hashlib.sha256(raw.encode()).hexdigest(), 'resources': selected}

def validate_config(config):
    if not isinstance(config.get('account'), str) or len(config['account']) != 12 or not config['account'].isdigit(): raise CleanupError('account must be a 12-digit AWS account ID')
    if not isinstance(config.get('regions'), list) or len(config['regions']) != 2 or len(set(config['regions'])) != 2: raise CleanupError('two distinct regions are required')
    if not isinstance(config.get('states'), list) or not config['states']: raise CleanupError('states are required')
    if sorted(s['kind'] for s in config['states']) != ['infra', 'sso', 'sso']: raise CleanupError('exactly one infra and two sso states are required')
    if sorted(s.get('region') for s in config['states'] if s['kind'] == 'sso') != sorted(config['regions']): raise CleanupError('one sso state per region is required')
    seen=set()
    for state in config['states']:
        if state.get('not_started') is True: continue
        if 'not_started' in state and state['not_started'] is not False: raise CleanupError('invalid not_started value')
        directory = str(Path(state['directory']).resolve())
        key = (directory, state['workspace'])
        if key in seen or not Path(directory, '.terraform').is_dir(): raise CleanupError('states must be distinct and initialized')
        seen.add(key)
        state['directory'] = directory
        if not state['workspace'] or '/' in state['workspace']: raise CleanupError('invalid workspace')
        state['var_file'] = str(Path(state['var_file']).resolve())
        if not Path(state['var_file']).is_file(): raise CleanupError('var file not found')
    if not isinstance(config.get('contexts'), dict) or set(config['contexts']) != set(config['regions']): raise CleanupError('contexts must list both regions')

def identity(config):
    actual = aws(config['regions'][0], 'sts', 'get-caller-identity')['Account']
    if actual != config['account']: raise CleanupError('AWS account mismatch')

def collect_vpc(region, vpc):
    filters = ['--filters', 'Name=vpc-id,Values='+vpc]
    instances = aws(region,'ec2','describe-instances',*filters)['Reservations']
    instances = [i for r in instances for i in r['Instances'] if i['State']['Name'] != 'terminated']
    volumes = sorted({m['Ebs']['VolumeId'] for i in instances for m in i.get('BlockDeviceMappings',[]) if 'Ebs' in m})
    lbs = [x['LoadBalancerArn'] for x in aws(region,'elbv2','describe-load-balancers')['LoadBalancers'] if x.get('VpcId') == vpc]
    tgs = [x['TargetGroupArn'] for x in aws(region,'elbv2','describe-target-groups')['TargetGroups'] if x.get('VpcId') == vpc]
    nats = [x for x in aws(region,'ec2','describe-nat-gateways','--filter','Name=vpc-id,Values='+vpc)['NatGateways'] if x['State'] != 'deleted']
    return {'vpc':vpc, 'instances':sorted(i['InstanceId'] for i in instances), 'volumes':volumes, 'load_balancers':sorted(lbs), 'target_groups':sorted(tgs), 'nat_gateways':sorted(x['NatGatewayId'] for x in nats), 'eips':sorted({a['AllocationId'] for n in nats for a in n.get('NatGatewayAddresses',[]) if a.get('AllocationId')})}

def inventory(config):
    identity(config)
    states=[]
    for entry in config['states']:
        if entry.get('not_started') is True:
            states.append({**entry, 'resources': []})
            continue
        details=state_details(entry)
        if not details['lineage']: raise CleanupError('state has no lineage; do not infer that an uninitialized or missing state is empty')
        for resource in details['resources']:
            if resource['type'] in ('aws_vpc', 'aws_eip', 'aws_eks_cluster', 'aws_cognito_user_pool', 'aws_ecr_repository') and not resource.get('id'):
                raise CleanupError('state has a resource with no identifier; manual recovery required')
            if resource['type'] == 'aws_db_instance' and not resource.get('identifier'):
                raise CleanupError('state has an RDS instance without an identifier')
            arn = resource.get('arn') or ''
            if arn.startswith('arn:'):
                parts = arn.split(':', 5)
                if len(parts) > 4 and parts[4] and parts[4] != config['account']:
                    raise CleanupError('state contains an ARN from another account')
                expected_region = entry.get('region') if entry['kind'] == 'sso' else (config['regions'][1] if resource['address'].startswith('module.secondary.') else config['regions'][0])
                if len(parts) > 3 and parts[3] and parts[3] != expected_region:
                    raise CleanupError('state contains an ARN from an unexpected region')
        states.append({**entry, **details})
    infra=next(s for s in states if s['kind']=='infra')
    vpcs=[]
    for obj in infra['resources']:
        if obj['type']=='aws_vpc' and obj.get('id'):
            region = config['regions'][1] if obj['address'].startswith('module.secondary.') else config['regions'][0]
            vpcs.append({'region':region, **collect_vpc(region,obj['id'])})
    # Include detached EBS volumes that still carry EKS ownership tags.
    for vpc in vpcs:
        prefix = 'module.secondary.' if vpc['region'] == config['regions'][1] else ''
        cluster = next((r['id'] for r in infra['resources'] if r['address'] == prefix+'aws_eks_cluster.demo'), None)
        if cluster:
            for volume in aws(vpc['region'],'ec2','describe-volumes')['Volumes']:
                tags = {t['Key']:t['Value'] for t in volume.get('Tags',[])}
                if tags.get('eks:cluster-name') == cluster or 'kubernetes.io/cluster/'+cluster in tags:
                    if volume['VolumeId'] not in vpc['volumes']: vpc['volumes'].append(volume['VolumeId'])
    # Terraform-owned addresses can survive NAT deletion or a partial apply.
    for obj in infra['resources']:
        if obj['type'] == 'aws_eip' and obj.get('id'):
            region = config['regions'][1] if obj['address'].startswith('module.secondary.') else config['regions'][0]
            target = next((v for v in vpcs if v['region'] == region), None)
            if target and obj['id'] not in target['eips']: target['eips'].append(obj['id'])
    if not vpcs and infra['resources']:
        raise CleanupError('infrastructure state contains resources without a captured VPC; manual inventory required')
    return {'version':1,'account':config['account'],'regions':config['regions'],'contexts':config['contexts'],'states':states,'vpcs':vpcs}

def cluster_context(snapshot, region):
    infra=next(s for s in snapshot['states'] if s['kind']=='infra')
    prefix='module.secondary.' if region == snapshot['regions'][1] else ''
    cluster=next((r for r in infra['resources'] if r['address']==prefix+'aws_eks_cluster.demo'),None)
    if not cluster: return None
    arn=cluster.get('arn') or ''
    expected=f":eks:{region}:{snapshot['account']}:cluster/"
    if expected not in arn or not arn.endswith('/'+str(cluster['id'])): raise CleanupError('cluster ARN does not match account and region')
    remote=aws(region,'eks','describe-cluster','--name',cluster['id'])['cluster']
    if remote['arn'] != arn: raise CleanupError('cluster identity mismatch')
    context=snapshot['contexts'][region]
    kube=json.loads(run(['kubectl','config','view','--minify','--context',context,'-o','json']))
    if len(kube.get('clusters',[])) != 1: raise CleanupError('kubectl context is not unique')
    cluster_config=kube['clusters'][0]['cluster']
    if cluster_config.get('server','').rstrip('/') != remote['endpoint'].rstrip('/') or cluster_config.get('insecure-skip-tls-verify') or cluster_config.get('certificate-authority-data') != remote['certificateAuthority']['data']:
        raise CleanupError('kubectl context endpoint or CA does not match EKS')
    return context

def delete_ingress(snapshot, region):
    context=cluster_context(snapshot,region)
    if not context: return
    raw=run(['kubectl','--context',context,'-n','integration-demo','get','ingress','sales-sso','--ignore-not-found','-o','json'])
    if not raw.strip(): return
    ingress=json.loads(raw)
    if ingress.get('metadata',{}).get('labels',{}).get('app.kubernetes.io/part-of') != 'sales-aws-demo': raise CleanupError('ingress ownership label missing; inspect manually')
    run(['kubectl','--context',context,'-n','integration-demo','delete','ingress','sales-sso','--wait=true','--timeout=300s'])

def destroy(snapshot):
    identity(snapshot)
    # Validate every state before the first mutation, including partially applied states.
    for entry in snapshot['states']:
        if entry.get('not_started') is True: continue
        now=state_details(entry)
        if now['digest'] != entry['digest']: raise CleanupError('state changed since inventory; capture a new inventory')
    for region in snapshot['regions']: cluster_context(snapshot,region)
    for region in snapshot['regions']: delete_ingress(snapshot,region)
    # Controller must finish before cluster and Cognito removal.
    for v in snapshot['vpcs']:
        remaining=collect_vpc(v['region'],v['vpc'])
        if set(v['load_balancers']) & set(remaining['load_balancers']) or set(v['target_groups']) & set(remaining['target_groups']): raise CleanupError('load balancer or target group remains; wait and retry before destroying states')
    # Terraform still prompts for each destroy plan. A failed stage stops the sequence.
    for entry in sorted(snapshot['states'],key=lambda s: s['kind']=='infra'):
        if entry.get('not_started') is True: continue
        env=clean_env(); env['TF_WORKSPACE']=entry['workspace']
        cmd=['terraform','-chdir='+entry['directory'],'destroy','-var-file='+entry['var_file']]
        if subprocess.run(cmd,env=env).returncode: raise CleanupError('destroy did not complete; inspect and capture a fresh inventory before retry')

def verify(snapshot):
    identity(snapshot)
    findings=[]
    for entry in snapshot['states']:
        if entry.get('not_started') is True:
            findings.append(f"UNCONFIRMED: {entry['kind']} {entry.get('region','')} was not inventoried; check manually")
            continue
        current=state_details(entry)
        if current['resources']: findings.append(f"state {entry['directory']} workspace {entry['workspace']}: {len(current['resources'])} resources remain")
    for v in snapshot['vpcs']:
        region=v['region']
        # Full-account list calls avoid treating NotFound/permission errors as absence.
        ec2=aws(region,'ec2','describe-instances')['Reservations']
        ids={i['InstanceId'] for r in ec2 for i in r['Instances'] if i['State']['Name'] != 'terminated'}
        volumes={x['VolumeId'] for x in aws(region,'ec2','describe-volumes')['Volumes']}
        eips={x['AllocationId'] for x in aws(region,'ec2','describe-addresses')['Addresses'] if x.get('AllocationId')}
        lbs={x['LoadBalancerArn'] for x in aws(region,'elbv2','describe-load-balancers')['LoadBalancers']}
        tgs={x['TargetGroupArn'] for x in aws(region,'elbv2','describe-target-groups')['TargetGroups']}
        nats={x['NatGatewayId'] for x in aws(region,'ec2','describe-nat-gateways')['NatGateways'] if x['State'] != 'deleted'}
        vpcs={x['VpcId'] for x in aws(region,'ec2','describe-vpcs')['Vpcs']}
        for name, actual in [('instances',ids),('volumes',volumes),('eips',eips),('load_balancers',lbs),('target_groups',tgs),('nat_gateways',nats),('vpc',vpcs)]:
            expected=[v['vpc']] if name=='vpc' else v[name]
            for resource in sorted(set(expected)&actual): findings.append(f'{region} {name}: {resource}')
    # IAM is global; check exact Terraform-recorded role names.
    roles = {r['RoleName'] for r in aws(snapshot['regions'][0],'iam','list-roles')['Roles']}
    for state in snapshot['states']:
        for resource in state['resources']:
            if resource['type']=='aws_iam_role' and resource.get('name') in roles:
                findings.append(f"IAM role: {resource['name']}")
    # Check DB, ECR, EKS and Cognito even when Terraform state was emptied.
    for region in snapshot['regions']:
        rds={x['DBInstanceIdentifier'] for x in aws(region,'rds','describe-db-instances')['DBInstances']}
        ecr={x['repositoryName'] for x in aws(region,'ecr','describe-repositories')['repositories']}
        eks=set(aws(region,'eks','list-clusters')['clusters'])
        cognito={x['Id'] for x in aws(region,'cognito-idp','list-user-pools','--max-results','60')['UserPools']}
        for state in snapshot['states']:
            for r in state['resources']:
                typ=r['type']; rid=r.get('id')
                if typ=='aws_db_instance' and r.get('identifier') in rds: findings.append(f"{region} RDS: {r['identifier']}")
                if typ=='aws_ecr_repository' and rid in ecr: findings.append(f'{region} ECR: {rid}')
                if typ=='aws_eks_cluster' and rid in eks: findings.append(f'{region} EKS: {rid}')
                if typ=='aws_cognito_user_pool' and rid in cognito: findings.append(f'{region} Cognito: {rid}')
    return findings

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('command',choices=['inventory','destroy','verify'])
    parser.add_argument('file')
    parser.add_argument('--output')
    args=parser.parse_args()
    try:
        data=json.loads(Path(args.file).read_text())
        if args.command=='inventory':
            if not args.output: raise CleanupError('--output is required')
            validate_config(data)
            snapshot=inventory(data)
            fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as f: json.dump(snapshot,f,indent=2)
            print('Inventory saved. Review it before cleanup.')
        elif args.command=='destroy':
            if data.get('version') != 1: raise CleanupError('invalid inventory')
            destroy(data)
            print('Destroy commands finished. Run verify using the saved inventory.')
        else:
            if data.get('version') != 1: raise CleanupError('invalid inventory')
            findings=verify(data)
            if findings:
                print('\n'.join(findings)); return 1
            print('Captured resources are absent. Complete the manual checks in CLEANUP.md.')
        return 0
    except (CleanupError,KeyError,ValueError,OSError,json.JSONDecodeError) as e:
        print('UNCONFIRMED:',str(e),file=sys.stderr); return 2
if __name__=='__main__': sys.exit(main())
