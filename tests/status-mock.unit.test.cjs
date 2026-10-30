'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handler } = require('../services/status-mock/server.cjs');

test('status-only HTTP mock returns only 200, 503 or errors', async () => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [endpoint, status] of [
      ['/healthz', 200], ['/status', 200], ['/status?code=200', 200],
      ['/status?code=503', 503], ['/status?code=418', 400], ['/missing', 404],
    ]) {
      const response = await fetch(base + endpoint);
      assert.equal(response.status, status);
      assert.equal(await response.text(), '');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
