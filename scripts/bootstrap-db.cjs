'use strict';
// Create demo schema/users via an SSH-free, local kubectl port forward to private RDS.
// No AWS provisioning occurs here. SQL credentials never appear in process args or git.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { runCommand } = require('../helpers/run-command.cjs');
const root = path.resolve(__dirname, '..');

async function out(name) {
  return (await runCommand('terraform', [`-chdir=${root}/infra`, 'output', '-raw', name])).stdout;
}
function escapeOption(s) { return `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`; }
function caConfig(username, password, caPath) {
  return `[client]\nuser=${escapeOption(username)}\npassword=${escapeOption(password)}\nssl-mode=VERIFY_CA\nssl-ca=${escapeOption(caPath)}\n`;
}
async function isListening(port) {
  return new Promise((resolve) => {
    const client = net.connect(port, '127.0.0.1');
    client.setTimeout(800);
    client.once('connect', () => { client.destroy(); resolve(true); });
    client.once('error', () => resolve(false));
    client.once('timeout', () => { client.destroy(); resolve(false); });
  });
}
async function waitForLocalPort(port, child) {
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error('kubectl port-forward ended unexpectedly');
    if (await isListening(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for kubectl port-forward');
}
async function applyK8s(context, manifest) {
  await runCommand('kubectl', ['--context', context, '-n', 'integration-demo', 'apply', '-f', '-'], {
    input: JSON.stringify(manifest), timeoutMs: 30_000,
  });
}
async function main() {
  const caPath = process.env.RDS_CA_FILE;
  if (!caPath || !fs.statSync(caPath).isFile()) throw new Error('Set RDS_CA_FILE to downloaded AWS RDS global-bundle.pem');
  const region = await out('region');
  const cluster = await out('cluster_name');
  const secondary = await out('secondary_cluster_name');
  const secretArn = await out('db_master_secret_arn');
  const secret = await runCommand('aws', [
    'secretsmanager', 'get-secret-value', '--secret-id', secretArn,
    '--region', region, '--query', 'SecretString', '--output', 'text',
  ], { timeoutMs: 30_000 });
  const master = JSON.parse(secret.stdout);
  if (!master.username || !master.password) throw new Error('Invalid RDS master secret');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-rds-'));
  fs.chmodSync(tmp, 0o700);
  const masterFile = path.join(tmp, 'master.cnf');
  fs.writeFileSync(masterFile, caConfig(master.username, master.password, caPath), { mode: 0o600 });
  const appPassword = crypto.randomBytes(24).toString('hex');
  const readPassword = crypto.randomBytes(24).toString('hex');
  let bridge;
  try {
    if (await isListening(13306)) throw new Error('Port 13306 is already in use; stop other forwards before DB initialization');
    bridge = spawn('kubectl', [
      '--context', cluster, '-n', 'integration-demo', 'port-forward',
      'svc/db-tunnel', '13306:3306', '--address', '127.0.0.1',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let bridgeError = '';
    bridge.stderr.on('data', (x) => { bridgeError += x.toString().slice(0, 200); });
    bridge.on('error', (error) => { bridgeError = error.message; });
    await waitForLocalPort(13306, bridge).catch((e) => { throw new Error(`${e.message}; ${bridgeError}`); });

    // All inserted password characters are server-generated hexadecimal, not user-supplied.
    const sql = `
CREATE TABLE IF NOT EXISTS integration_demo.items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  test_key VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE USER IF NOT EXISTS 'demo_app'@'%' IDENTIFIED BY '${appPassword}' REQUIRE SSL;
ALTER USER 'demo_app'@'%' IDENTIFIED BY '${appPassword}' REQUIRE SSL;
GRANT INSERT, SELECT ON integration_demo.items TO 'demo_app'@'%';
CREATE USER IF NOT EXISTS 'integration_ro'@'%' IDENTIFIED BY '${readPassword}' REQUIRE SSL;
ALTER USER 'integration_ro'@'%' IDENTIFIED BY '${readPassword}' REQUIRE SSL;
GRANT SELECT ON integration_demo.items TO 'integration_ro'@'%';
`;
    await runCommand('mysql', [
      `--defaults-file=${masterFile}`, '--host=127.0.0.1', '--port=13306',
      '--protocol=TCP', '--database=integration_demo', '--batch', '--silent',
    ], { input: sql, timeoutMs: 30_000 });

    for (const context of [cluster, secondary]) {
    await applyK8s(context, {
      apiVersion: 'v1', kind: 'Secret',
      metadata: { name: 'app-db', namespace: 'integration-demo' },
      type: 'Opaque', stringData: { username: 'demo_app', password: appPassword },
    });
    const ca = fs.readFileSync(caPath, 'utf8');
    await applyK8s(context, {
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: 'rds-ca', namespace: 'integration-demo' },
      data: { 'global-bundle.pem': ca },
    });

    }

    const privateDir = path.join(os.homedir(), '.config', 'play-right-demo');
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(privateDir, 0o700);
    const target = path.join(privateDir, 'mysql-readonly.cnf');
    fs.writeFileSync(target, caConfig('integration_ro', readPassword, caPath), { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    console.log('RDS schema, restricted DB users, Kubernetes Secret and CA ConfigMap configured.');
    console.log(`Read-only MySQL credentials saved to ${target} (mode 0600, outside repository).`);
  } finally {
    if (bridge && bridge.exitCode === null) bridge.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('DB bootstrap failed:', error.message); process.exitCode = 1; });
