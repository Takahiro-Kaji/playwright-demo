import importlib.util
import json
import pathlib
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('cleanup', pathlib.Path(__file__).parents[1] / 'cleanup/ingress.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ACCOUNT = '123456789012'
REGION = 'ap-northeast-1'
ALB = f'arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:loadbalancer/app/demo/123abc'

def result(code=0, output='', error=''):
    return subprocess.CompletedProcess([], code, output, error)

class CleanupTest(unittest.TestCase):
    def test_deletes_only_after_matching_and_waits(self):
        responses = iter([result(output=json.dumps({'Account': ACCOUNT})), result(output=json.dumps({'status': {'loadBalancer': {'ingress': [{'hostname': 'demo.example'}]}}})), result(output=json.dumps({'LoadBalancers': [{'DNSName': 'demo.example'}]})), result(), result(error='LoadBalancerNotFound', code=1)])
        calls = []
        def runner(command):
            calls.append(command)
            return next(responses)
        module.cleanup(ACCOUNT, REGION, 'cluster', ALB, runner, lambda _: None)
        self.assertIn('delete', calls[3])
    def test_resume_after_ingress_is_gone(self):
        responses = iter([result(output=json.dumps({'Account': ACCOUNT})), result(), result(code=1, error='LoadBalancerNotFound')])
        module.cleanup(ACCOUNT, REGION, 'cluster', ALB, lambda _: next(responses), lambda _: None)
    def test_denied_is_failure_not_absence(self):
        responses = iter([result(output=json.dumps({'Account': ACCOUNT})), result(), result(code=1, error='AccessDenied')])
        with self.assertRaisesRegex(RuntimeError, 'rerun'):
            module.cleanup(ACCOUNT, REGION, 'cluster', ALB, lambda _: next(responses), lambda _: None)
    def test_wrong_account_stops_before_delete(self):
        calls = []
        def runner(command):
            calls.append(command)
            return result(output=json.dumps({'Account': '000000000000'}))
        with self.assertRaises(RuntimeError):
            module.cleanup(ACCOUNT, REGION, 'cluster', ALB, runner)
        self.assertEqual(len(calls), 1)

if __name__ == '__main__':
    unittest.main()
