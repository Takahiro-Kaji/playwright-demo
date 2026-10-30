'use strict';
const { expect } = require('@playwright/test');
const { test } = require('../../../test-support/batch-fixture.cjs');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { captureJson } = require('../../../test-support/http-snapshot.cjs');
const { prepare, startBatch, snapshot, expected, compare } = require('../../targets/demo-reference/target.cjs');
const small = require('../../targets/demo-reference/data/small.json');
test('full import compares all parent and child rows and detects faults', async ({ batchState: state }) => {
  const evidence = state.evidence;
  const work = state.work = process.env.BATCH_WORK_DIR;
  if (!work) throw new Error('Dedicated batch work directory required');
  await fsp.mkdir(work, { recursive: true, mode: 0o700 });
  const snapshotFile = path.join(work, 'upstream.json');
  const connection = JSON.parse(fs.readFileSync(process.env.BATCH_CONNECTION_FILE, 'utf8'));
  const db = state.db = await prepare(connection);
    // Given: capture completely, then freeze the expected rows before the batch starts.
    evidence.phase = 'given';
    evidence.input = await captureJson(`${process.env.BATCH_SOURCE_URL}/records`, snapshotFile);
    const records = JSON.parse(await fsp.readFile(snapshotFile, 'utf8'));
    const want = expected(records);
    if (records.length === 2) {
      expect(want).toEqual({ parents: [{ id: '9007199254740993', destination: 'east', label: 'Alpha', note: null }, { id: '9007199254740995', destination: 'west', label: 'Beta', note: '' }], children: [{ id: '9007199254741001', parent_id: '9007199254740993', destination: 'east', value: '' }, { id: '9007199254741002', parent_id: '9007199254740995', destination: 'west', value: 'value' }] });
    }
    // When: the independent command retrieves the source and performs per-query commits.
    evidence.phase = 'when';
    const started = Date.now();
    if (process.env.BATCH_VERIFY_TIMEOUT === '1') test.setTimeout(1000);
    state.batch = startBatch(process.env.BATCH_CONNECTION_FILE, `${process.env.BATCH_SOURCE_URL}/records`, (process.env.BATCH_VERIFY_TIMEOUT === '1' || process.env.BATCH_VERIFY_SIGNAL === '1') ? { BATCH_VERIFY_HANG: '1' } : {});
    await state.batch.completion;
    evidence.batch = { exit: 0, durationMs: Date.now() - started };
    // Then: read both tables in full, without JOIN or filtering away anomalies.
    evidence.phase = 'then';
    const got = await snapshot(db); evidence.differences = compare(want, got);
    expect(evidence.differences).toEqual([]);
    evidence.measurement = { parentRows: got.parents.length, childRows: got.children.length, elapsedMs: Date.now() - started, runnerRssBytes: process.memoryUsage().rss, scope: 'Playwright worker RSS only; excludes sync process, server and MySQL' };
    if (records.length === 2) {
      const injections = [
        ['missing', "DELETE FROM children WHERE id=9007199254741001", 'children', '9007199254741001', 'missing'],
        ['duplicate', "INSERT INTO children SELECT * FROM children WHERE id=9007199254741001", 'children', '9007199254741001', 'duplicate'],
        ['extra', "INSERT INTO children VALUES (9007199254741999,9007199254740993,'east','extra')", 'children', '9007199254741999', 'extra'],
        ['destination', "UPDATE parents SET destination='wrong' WHERE id=9007199254740993", 'parents', '9007199254740993', 'destination'],
        ['relation', "UPDATE children SET parent_id=42 WHERE id=9007199254741001", 'children', '9007199254741001', 'relation'],
        ['value', "UPDATE parents SET label='wrong' WHERE id=9007199254740993", 'parents', '9007199254740993', 'value'],
        ['delete', "INSERT INTO parents VALUES (1,'old','obsolete',NULL)", 'parents', '1', 'extra'],
        ['null', "UPDATE parents SET note='' WHERE id=9007199254740993", 'parents', '9007199254740993', 'value'],
        ['bigint', "UPDATE parents SET id=9007199254740992 WHERE id=9007199254740993", 'parents', '9007199254740993', 'missing'],
      ];
      for (const [name, sql, table, id, type] of injections) {
        await db.beginTransaction();
        try { await db.query(sql); const diff = compare(want, await snapshot(db)); expect(diff).toEqual(expect.arrayContaining([expect.objectContaining({ table, id, type })])); evidence.checks.push({ name, expected: { table, id, type }, observed: diff, detection: 'PASS', business: 'FAIL' }); }
        finally { await db.rollback(); }
      }
      for (const endpoint of ['broken', 'invalid']) {
        const destination = path.join(work, endpoint); await expect(captureJson(`${process.env.BATCH_SOURCE_URL}/${endpoint}`, destination)).rejects.toThrow(); expect(fs.existsSync(destination)).toBe(false); evidence.checks.push({ name: endpoint, detection: 'PASS', business: 'unconfirmed' });
      }
      state.batch = startBatch(process.env.BATCH_CONNECTION_FILE, `${process.env.BATCH_SOURCE_URL}/invalid`);
      await expect(state.batch.completion).rejects.toThrow();
      evidence.checks.push({ name: 'batch-failure', detection: 'PASS', business: 'unconfirmed' });
    }
    if (process.env.BATCH_VERIFY_CLEANUP === '1') throw new Error('injected business failure');
});
