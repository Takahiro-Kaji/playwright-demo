'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { runCommand } = require('./run-command.cjs');
const { required } = require('./kubernetes.cjs');
async function control(target, status, run = runCommand) {
  const config = required('MOCK_CURL_CONFIG');
  const stat = fs.statSync(config);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('MOCK_CURL_CONFIG must be a private file (0600)');
  const url = new URL('/admin/status', target.adminUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Mock admin must use a loopback port-forward');
  const args = ['--disable', '--config', config, '--silent', '--show-error', '--connect-timeout', '3', '--max-time', '5',
    '--write-out', '\n%{http_code}'];
  if (status !== undefined) args.push('--request', 'PUT', '--header', 'Content-Type: application/json', '--data-binary', JSON.stringify({ status }));
  args.push(url.href);
  const { stdout } = await run('curl', args, { timeoutMs: 7000 });
  const split = stdout.lastIndexOf('\n');
  if (stdout.slice(split + 1) !== '200') throw new Error('Mock control failed (non-200)');
  const state = JSON.parse(stdout.slice(0, split));
  assert.equal(state.region, target.region, 'Admin response came from a different region');
  return state;
}
async function probe(target, state) {
  const response = await fetch(`${target.mockUrl}/status`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  await response.arrayBuffer();
  assert.equal(response.status, state.status, 'Mock business HTTP status differs from precondition');
  assert.equal(response.headers.get('x-mock-region'), target.region);
  assert.equal(response.headers.get('x-mock-version'), String(state.version));
  assert.equal(response.headers.get('x-mock-instance-id'), state.instanceId);
  return { status: response.status, headers: Object.fromEntries(response.headers) };
}
module.exports = { control, probe };
