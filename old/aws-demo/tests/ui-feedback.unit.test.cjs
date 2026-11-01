'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const cases = require('./cases.cjs');
const { FORM_JS } = require('../services/demo-app/server.cjs');

async function runForm({ status = 201, networkError = false } = {}) {
  const attributes = { role: 'status', 'aria-live': 'polite' };
  const result = {
    textContent: '', dataset: { state: 'idle' },
    setAttribute(name, value) { attributes[name] = value; },
    getAttribute(name) { return attributes[name]; },
  };
  let submit;
  const form = {
    elements: { testKey: { value: 'it-12345678-1234-1234-1234-123456789abc' } },
    addEventListener(event, fn) { assert.equal(event, 'submit'); submit = fn; },
  };
  const browser = {
    document: {
      getElementById(id) { assert.equal(id, 'item-form'); return form; },
      querySelector(sel) { assert.equal(sel, '[data-testid="item-create-result"]'); return result; },
    },
    fetch: async (url, opts) => {
      assert.equal(url, '/api/items');
      assert.equal(opts.method, 'POST');
      assert.ok(JSON.parse(opts.body).testKey.startsWith('it-'));
      if (networkError) throw new Error('network unavailable');
      return { ok: status >= 200 && status < 300, status };
    },
  };
  vm.runInNewContext(FORM_JS, browser);
  assert.equal(typeof submit, 'function');
  await submit({ preventDefault() {}, currentTarget: form });
  return { text: result.textContent, role: result.getAttribute('role'), state: result.dataset.state,
    live: result.getAttribute('aria-live') };
}

test('All test cases use a single expected mock/HTTP status and an explicit UI expectation', () => {
  assert.deepEqual(cases.map((c) => c.id), ['both-ok', 'both-unavailable', 'no-switch']);
  for (const scenario of cases) {
    assert.ok(Number.isInteger(scenario.mockStatus));
    assert.ok(Number.isInteger(scenario.httpStatus));
    assert.ok(scenario.changeStatus === null || scenario.changeStatus === scenario.mockStatus);
    assert.equal(typeof scenario.ui.text, 'string');
    assert.ok(scenario.ui.text.length > 0);
    assert.ok(['before-after', 'after-only', 'none'].includes(scenario.db));
    assert.ok(['status', 'alert'].includes(scenario.ui.role));
  }
});

test('UI feedback matches the declared normal/error expectations', async () => {
  for (const scenario of cases) {
    assert.deepEqual(await runForm({ status: scenario.httpStatus }), scenario.ui);
  }
});

test('Unexpected backend errors and network errors render an accessible error message', async () => {
  assert.deepEqual(await runForm({ status: 500 }),
    { text: '登録できませんでした', role: 'alert', state: 'error', live: 'assertive' });
  assert.deepEqual(await runForm({ networkError: true }),
    { text: '通信エラー', role: 'alert', state: 'error', live: 'assertive' });
});
