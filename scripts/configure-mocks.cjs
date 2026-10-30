'use strict';
// Explicit provisioning step: writes only namespaces + admin Secrets, never prints the token.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { runCommand } = require('../helpers/run-command.cjs');
async function main() {
  const root = path.resolve(__dirname, '..');
  const output = JSON.parse((await runCommand('terraform', [`-chdir=${root}/infra`, 'output', '-json'])).stdout);
  const dir = path.join(os.homedir(), '.config', 'play-right-demo');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'mock-admin.token');
  const token = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : randomBytes(32).toString('hex');
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid existing admin token file');
  fs.writeFileSync(file, token, { mode: 0o600 }); fs.chmodSync(file, 0o600);
  const config = path.join(dir, 'mock-curl.conf');
  fs.writeFileSync(config, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 }); fs.chmodSync(config, 0o600);
  for (const key of ['cluster_name', 'secondary_cluster_name']) {
    const context = output[key].value;
    await runCommand('kubectl', ['--context', context, 'apply', '-f', `${root}/k8s/namespace.yaml`]);
    await runCommand('kubectl', ['--context', context, '-n', 'integration-demo', 'apply', '-f', '-'], {
      input: JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'mock-admin', namespace: 'integration-demo' },
        type: 'Opaque', stringData: { token } }),
    });
  }
  console.log('Two regional mock-admin Secrets configured. Private curl config written outside repository.');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
