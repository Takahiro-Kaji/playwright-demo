'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
function command(cmd, args, input) {
  const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr}`);
  return result.stdout;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function startLocalMysql() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-right-local-'));
  const data = path.join(dir, 'data'); const socket = path.join(dir, 'mysql.sock');
  let daemon;
  async function stop() {
    if (daemon && !daemon.spawnError && daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), delay(5000)]);
      if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await new Promise((resolve) => daemon.once('exit', resolve)); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  try {
    fs.mkdirSync(data);
    command('mysqld', ['--no-defaults', '--initialize-insecure', `--datadir=${data}`]);
    const port = await freePort();
    daemon = spawn('mysqld', ['--no-defaults', `--datadir=${data}`, `--socket=${socket}`, `--port=${port}`, '--bind-address=127.0.0.1', '--mysqlx=0', `--pid-file=${dir}/mysql.pid`, `--log-error=${dir}/mysql.log`], { stdio: 'ignore' });
    daemon.on('error', (error) => { daemon.spawnError = error; });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (daemon.spawnError) throw daemon.spawnError;
      if (daemon.exitCode !== null) throw new Error('Disposable MySQL exited before readiness');
      if (spawnSync('mysqladmin', ['--no-defaults', `--socket=${socket}`, '-u', 'root', 'ping'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
      await delay(200);
    }
    if (!ready) throw new Error('Disposable MySQL did not start');
    command('mysql', ['--no-defaults', `--socket=${socket}`, '-u', 'root'], "CREATE DATABASE integration_demo; CREATE USER 'local_test'@'127.0.0.1' IDENTIFIED BY 'local_test_password'; GRANT ALL ON integration_demo.* TO 'local_test'@'127.0.0.1';");
    const optionsFile = path.join(dir, 'client.cnf');
    fs.writeFileSync(optionsFile, '[client]\npassword=local_test_password\n', { mode: 0o600 });
    return { connection: { host: '127.0.0.1', port, user: 'local_test', password: 'local_test_password', database: 'integration_demo', optionsFile }, stop };
  } catch (error) { await stop(); throw error; }
}
module.exports = { startLocalMysql };
