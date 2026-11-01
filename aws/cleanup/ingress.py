#!/usr/bin/env python3
"""Delete one demo ingress and wait for its recorded ALB to disappear."""
import argparse
import json
import re
import subprocess
import sys
import time


def run(args):
    return subprocess.run(args, text=True, capture_output=True, check=False)


def cleanup(account, region, context, alb, runner=run, sleep=time.sleep, attempts=60):
    def fail(message):
        raise RuntimeError(f'{message}; rerun for context {context}, ALB {alb}')
    if not re.fullmatch(r'\d{12}', account) or not re.fullmatch(r'[a-z0-9-]+', region):
        fail('invalid account or region')
    if not re.fullmatch(r'arn:aws(?:-[a-z]+)?:elasticloadbalancing:' + re.escape(region) + ':' + account + r':loadbalancer/app/[A-Za-z0-9-]+/[a-f0-9]+', alb):
        fail('invalid or mismatched ALB ARN')
    if not context or context.startswith('-'):
        fail('invalid context')
    identity = runner(['aws', 'sts', 'get-caller-identity', '--output', 'json'])
    try:
        if identity.returncode or json.loads(identity.stdout)['Account'] != account:
            fail('AWS account verification failed')
    except (ValueError, KeyError):
        fail('AWS account verification failed')
    # Confirm the ALB belongs to this cluster's recorded ingress before deleting it.
    get = runner(['kubectl', '--context', context, '-n', 'integration-demo', 'get', 'ingress', 'sales-sso', '-o', 'json', '--ignore-not-found'])
    if get.returncode:
        fail('cannot inspect ingress')
    if get.stdout.strip():
        try:
            host = json.loads(get.stdout)['status']['loadBalancer']['ingress'][0]['hostname']
            desc = runner(['aws', 'elbv2', 'describe-load-balancers', '--region', region, '--load-balancer-arns', alb, '--output', 'json'])
            if desc.returncode or json.loads(desc.stdout)['LoadBalancers'][0]['DNSName'] != host:
                fail('recorded ALB does not match ingress')
        except (ValueError, KeyError, IndexError):
            fail('cannot match ingress to ALB')
        deleted = runner(['kubectl', '--context', context, '-n', 'integration-demo', 'delete', 'ingress', 'sales-sso', '--wait=true', '--timeout=5m'])
        if deleted.returncode:
            fail('ingress deletion failed')
    for _ in range(attempts):
        desc = runner(['aws', 'elbv2', 'describe-load-balancers', '--region', region, '--load-balancer-arns', alb, '--output', 'json'])
        if desc.returncode and 'LoadBalancerNotFound' in desc.stderr:
            return
        if desc.returncode:
            fail('ALB check failed')
        sleep(5)
    fail('ALB still exists')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('account', 'region', 'context', 'alb'):
        parser.add_argument('--' + option, required=True)
    args = parser.parse_args()
    try:
        cleanup(args.account, args.region, args.context, args.alb)
    except (RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print('Ingress absent and recorded ALB no longer exists.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
