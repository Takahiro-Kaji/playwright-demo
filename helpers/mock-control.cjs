'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { runCommand } = require('./run-command.cjs');
const { required } = require('./kubernetes.cjs');
function validateState(state, target) {
  assert.equal(state.region, target.region, 'Admin response came from a different region');
  assert.ok(Number.isInteger(state.status) && state.status >= 200 && state.status <= 599, 'Invalid mock status');
  assert.ok(Number.isSafeInteger(state.version) && state.version >= 0, 'Invalid mock version');
  assert.ok(typeof state.instanceId === 'string' && state.instanceId.length > 0, 'Missing mock instance identity');
}
async function requestControl(target, status, expected, run) {
  const config = required('MOCK_CURL_CONFIG');
  const stat = fs.statSync(config);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('MOCK_CURL_CONFIG must be a private file (0600)');
  const url = new URL('/admin/status', target.adminUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Mock admin must use a loopback port-forward');
  const args = ['--disable', '--config', config, '--silent', '--show-error', '--connect-timeout', '3', '--max-time', '5',
    '--write-out', '\n%{http_code}'];
  if (status !== undefined) args.push('--request', 'PUT', '--header', 'Content-Type: application/json', '--data-binary', JSON.stringify({ status, ...(expected ? { expected } : {}) }));
  args.push(url.href);
  try {
    const { stdout } = await run('curl', args, { timeoutMs: 7000 });
    const split = stdout.lastIndexOf('\n');
    const code = stdout.slice(split + 1);
    const state = JSON.parse(stdout.slice(0, split));
    if (code === '409') {
      const error = new Error('Mock state changed or restarted; conditional update refused');
      error.code = 'MOCK_STATE_CONFLICT';
      error.currentState = state.current;
      throw error;
    }
    if (code !== '200') throw new Error(`Mock control failed (HTTP ${code})`);
    validateState(state, target);
    if (status !== undefined) assert.equal(state.status, status, 'Admin did not apply requested status');
    if (expected) {
      assert.equal(state.instanceId, expected.instanceId, 'Mock restarted during conditional update');
      assert.equal(state.version, expected.version + 1, 'Unexpected conditional update version');
    }
    return state;
  } catch (error) {
    // A timeout, lost response, or invalid reply does not establish whether PUT
    // committed. Never infer ownership by issuing another GET or retrying PUT.
    if (status !== undefined && error.code !== 'MOCK_STATE_CONFLICT') error.ownershipUnknown = true;
    throw error;
  }
}
async function control(target, status, run = runCommand) { return requestControl(target, status, undefined, run); }
async function compareAndSet(target, status, expected, run = runCommand) {
  validateState(expected, target);
  return requestControl(target, status, expected, run);
}
async function probe(target, state) {
  const response = await fetch(`${target.mockUrl}/status`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  await response.arrayBuffer();
  const observed = { status: response.status, headers: Object.fromEntries(response.headers) };
  try {
    assert.equal(response.status, state.status, 'Mock business HTTP status differs from precondition');
    assert.equal(response.headers.get('x-mock-region'), target.region);
    assert.equal(response.headers.get('x-mock-version'), String(state.version));
    assert.equal(response.headers.get('x-mock-instance-id'), state.instanceId);
    return observed;
  } catch (error) { error.probe = observed; throw error; }
}
module.exports = { control, compareAndSet, probe };
