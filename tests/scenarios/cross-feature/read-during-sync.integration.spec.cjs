'use strict';
const { expect } = require('@playwright/test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { test } = require('../../../test-support/cross-fixture.cjs');
const { captureJson } = require('../../../test-support/http-snapshot.cjs');
const { prepare, startBatch, snapshot, expected, compare } = require('../../targets/demo-reference/target.cjs');
const { overlap } = require('../../targets/demo-reference/ui.cjs');

const now = () => performance.timeOrigin + performance.now();
async function sampleCount(db) {
  const start = now(); const [rows] = await db.query('SELECT COUNT(*) AS count FROM parents');
  return { start, end: now(), count: Number(rows[0].count) };
}
async function readUi(page, db) {
  let operation; const samples = []; let active = true; let samplingError;
  const sampler = (async () => { while (active) { try { samples.push(await sampleCount(db)); } catch (e) { samplingError = e; break; } } })();
  let response, text;
  try {
    const pending = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/reference' && r.request().method() === 'GET');
    await page.getByTestId('refresh').click(); response = await pending;
    await expect(page.getByTestId('result')).toHaveAttribute('data-state', 'ready');
    text = await page.getByTestId('result').innerText();
    await response.finished();
    const timing = response.request().timing();
    if (timing.requestStart < 0 || timing.responseEnd < timing.requestStart) throw new Error('HTTP timing unavailable');
    operation = { start: timing.startTime + timing.requestStart, end: timing.startTime + timing.responseEnd, basis: 'browser HTTP request start to response end; epoch milliseconds' };
  } finally { active = false; await sampler; }
  if (samplingError) throw samplingError;
  expect(response.status()).toBe(200);
  expect(text).toMatch(/^親データ: \d+件$/);
  return { operation, samples, status: response.status(), text, overlap: overlap(operation, samples) };
}

test('UI reads while the demo synchronization commits', async ({ page, crossState: state }) => {
  const e = state.evidence;
  const pageErrors = []; let crashed = false;
  page.on('pageerror', (err) => pageErrors.push(err.message)); page.on('crash', () => { crashed = true; });
  // Given: dedicated database, input snapshot and Chrome prepared before synchronization.
  state.work = process.env.BATCH_WORK_DIR;
  if (!state.work) throw new Error('Dedicated work directory required');
  state.db = await prepare(JSON.parse(fs.readFileSync(process.env.BATCH_CONNECTION_FILE, 'utf8')));
  const file = path.join(state.work, 'source.json');
  e.input = await captureJson(`${process.env.BATCH_SOURCE_URL}/records`, file);
  const want = expected(JSON.parse(await fsp.readFile(file, 'utf8')));
  await page.goto(`${process.env.CROSS_VIEW_URL}/reference`);
  await expect(page.getByTestId('refresh')).toBeVisible();
  // When: start the real sync and observe bounded real UI operations during its commits.
  if (process.env.CROSS_VERIFY_NO_OVERLAP === '1') e.attempts.push(await readUi(page, state.db));
  e.batchStart = now();
  state.batch = startBatch(process.env.BATCH_CONNECTION_FILE, `${process.env.BATCH_SOURCE_URL}/records`);
  let batchFinished = false; state.batch.completion.finally(() => { batchFinished = true; }).catch(() => {});
  if (process.env.CROSS_VERIFY_NO_OVERLAP !== '1') {
    // An observed positive count indicates a committed insert after the sync's deletes.
    while (!batchFinished) { const s = await sampleCount(state.db); if (s.count > 1 && s.count < 15000) break; }
    for (let i = 0; i < 15 && !batchFinished; i++) {
      const attempt = await readUi(page, state.db); e.attempts.push(attempt);
      if (attempt.overlap.status === 'established') break;
    }
  }
  e.overlap = e.attempts.some((a) => a.overlap.status === 'established') ? 'established' : 'unconfirmed';
  e.ui = e.attempts.length ? 'PASS' : 'unconfirmed';
  // Then: recover completion, compare all rows, and read the finished UI independently.
  await state.batch.completion; e.batchEnd = now(); e.batch = 'completed';
  const diff = compare(want, await snapshot(state.db)); e.finalDifferences = diff;
  expect(diff).toEqual([]); e.finalComparison = 'PASS';
  const final = await readUi(page, state.db); e.finalUi = { status: final.status, text: final.text };
  expect(final.text).toBe('親データ: 15000件');
  expect(pageErrors).toEqual([]); expect(crashed).toBe(false);
  if (e.overlap !== 'established') throw new Error('OVERLAP_UNCONFIRMED');
});
