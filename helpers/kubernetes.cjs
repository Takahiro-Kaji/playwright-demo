'use strict';
const { runCommand } = require('./run-command.cjs');

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

async function assertDeploymentReady(targetDeployment = null) {
  const context = required('KUBE_CONTEXT');
  const namespace = required('KUBE_NAMESPACE');
  const deployment = targetDeployment || required('KUBE_DEPLOYMENT');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(deployment)) {
    throw new Error('Invalid Kubernetes Deployment name');
  }
  const common = ['--context', context, '--namespace', namespace];

  // All commands are read-only; passing --context prevents accidental use of the default context.
  await runCommand('kubectl', [
    ...common, 'rollout', 'status', `deployment/${deployment}`, '--timeout=60s',
  ], { timeoutMs: 75_000 });

  const { stdout } = await runCommand('kubectl', [
    ...common, 'get', `deployment/${deployment}`, '--output=json',
  ], { timeoutMs: 20_000 });
  const obj = JSON.parse(stdout);
  const desired = obj.spec?.replicas ?? 1;
  const available = obj.status?.availableReplicas ?? 0;
  const updated = obj.status?.updatedReplicas ?? 0;
  const observed = obj.status?.observedGeneration ?? 0;
  const generation = obj.metadata?.generation ?? 0;
  if (desired < 1 || available < desired || updated < desired || observed < generation) {
    throw new Error(`Deployment not fully ready: desired=${desired}, available=${available}, updated=${updated}, observedGeneration=${observed}, generation=${generation}`);
  }
  // Return only diagnostic metadata, never environment variables or Kubernetes secrets.
  return {
    context, namespace, deployment, desired, available, updated, generation,
    images: (obj.spec?.template?.spec?.containers ?? []).map((c) => c.image),
  };
}

module.exports = { assertDeploymentReady, required };
