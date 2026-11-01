import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { fixture } from '../../tests/verification/aws-sales/fixtures.ts';
import { saveJournal, loadJournal, exclusive } from '../../tests/aws-sales/environment.ts';
import { Environment } from '../../tests/aws-sales/lifecycle.ts';
import { checkProbeTarget, withProbeDatabase } from './probe-database.ts';

function setup() {
  const f = fixture();
  Object.assign(f.j, { phase: 'prepared', dbCreated: true, dbOwned: true, userCreated: true });
  saveJournal(f.file, f.j);
  const target = { target: f.j.config.url, expected: f.j.config.url, state: f.j.config.stateFile,
    selector: '#refresh', cognitoDomain: 'test.auth.ap-northeast-1.amazoncognito.com' };
  const calls: string[] = [];
  const opts = { db: f.j.database, principal: `${f.j.user}@%`, owner: f.j.owner, permission: true, verify: true, acquired: 1, released: 1 };
  const connection = {
    async query(input: string | { sql: string }) {
      const sql = typeof input === 'string' ? input : input.sql;
      calls.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: opts.acquired }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: opts.released }]];
      if (!opts.permission) throw Object.assign(Error('password/rows must not escape'), {code:'ER_TABLEACCESS_DENIED_ERROR'});
      if (sql.includes('CURRENT_USER')) return [[{ db: opts.db, principal: opts.principal }]];
      if (sql.includes('aws_test_owner')) return [[{ run_id: f.j.runId, owner_token: opts.owner }]];
      return [[]];
    },
    release() { calls.push('release'); },
    destroy() { calls.push('destroy'); },
  };
  const pool = { async getConnection() { calls.push('connection'); return connection; }, async end() { calls.push('end'); } };
  const create = () => ({ async verifyTarget() { calls.push('verify'); if (!opts.verify) throw Error('ALB_TARGET_MISMATCH'); },
    async pool() { calls.push('pool'); return pool; } }) as unknown as Environment;
  return { ...f, target, calls, opts, create, connection };
}

test('journal is mandatory; direct DB environment variables cannot enable a fallback', async () => {
  const f = setup();
  try { await assert.rejects(withProbeDatabase(undefined, f.target, async () => assert.fail()), /PROBE_JOURNAL_REQUIRED/); }
  finally { f.close(); }
});

test('owned target retains one locked connection through probe and After, then closes tunnel and journal lock', async () => {
  const f = setup();
  try {
    await withProbeDatabase(f.file, f.target, async db => {
      assert.equal(db, f.connection);
      assert.ok(existsSync(f.file + '.lock'));
      f.calls.push('probe-and-after');
    }, f.create);
    assert.deepEqual(f.calls.slice(0, 3), ['verify', 'pool', 'connection']);
    assert.ok(f.calls.indexOf('probe-and-after') > f.calls.findIndex(s => s.includes('aws_test_owner')));
    assert.deepEqual(f.calls.slice(-4), ['probe-and-after', "SELECT RELEASE_LOCK('sales-aws-business-tests') AS released", 'release', 'end']);
    assert.equal(existsSync(f.file + '.lock'), false);
  } finally { f.close(); }
});

for (const field of ['target', 'expected', 'state', 'cognitoDomain'] as const) test(`rejects mismatched ${field} before external access`, async () => {
  const f = setup();
  try {
    await assert.rejects(withProbeDatabase(f.file, {...f.target, [field]:'other'}, async () => assert.fail(), f.create), /PROBE_DATABASE_OR_CHECK_FAILED/);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

for (const change of [{blocked:true}, {phase:'new'}, {dbOwned:false}, {dbCreated:false}, {userCreated:false}]) test(`rejects unready journal ${JSON.stringify(change)}`, () => {
  const f = setup();
  try { assert.throws(() => checkProbeTarget({...f.j, ...change}, f.target), /PROBE_JOURNAL_NOT_READY/); }
  finally { f.close(); }
});

for (const change of [{db:'integration_demo'}, {principal:'admin@%'}, {owner:'wrong'}, {permission:false}, {verify:false}, {acquired:0}]) test(`rejects target/ownership/permission/lock failure ${JSON.stringify(change)}`, async () => {
  const f = setup();
  try {
    Object.assign(f.opts, change);
    await assert.rejects(withProbeDatabase(f.file, f.target, async () => assert.fail('probe must not run'), f.create), (error: AggregateError) => {
      assert.ok(error.errors.every(e => /^[A-Z][A-Z0-9_]+$/.test(e.message)));
      assert.ok(!JSON.stringify(error.errors).includes('password/rows'));
      return true;
    });
    assert.equal(existsSync(f.file + '.lock'), false);
    if (change.verify === false) assert.deepEqual(f.calls, ['verify']);
    else assert.equal(f.calls.at(-1), 'end');
  } finally { f.close(); }
});

test('preserves probe and cleanup errors, blocks journal, and closes connection', async () => {
  const f = setup();
  try {
    await assert.rejects(withProbeDatabase(f.file, f.target, async () => {
      throw new AggregateError([Error('PROBE_FAILED'), Error('CLEANUP_FAILED')], 'PROBE_AND_CLEANUP_FAILED');
    }, f.create), (e: AggregateError) => {
      assert.deepEqual(e.errors.map(e => e.message), ['PROBE_AND_CLEANUP_FAILED', 'PROBE_FAILED', 'CLEANUP_FAILED']); return true;
    });
    assert.equal(loadJournal(f.file).blocked, true);
    assert.equal(f.calls.at(-1), 'end');
  } finally { f.close(); }
});

test('lost DB lock cannot pass and destroys session', async () => {
  const f = setup(); f.opts.released = 0;
  try {
    await assert.rejects(withProbeDatabase(f.file, f.target, async () => {}, f.create));
    assert.ok(f.calls.includes('destroy'));
    assert.equal(loadJournal(f.file).blocked, true);
  } finally { f.close(); }
});

test('concurrent journal operation is rejected before any external access', async () => {
  const f = setup(), unlock = exclusive(f.file);
  try { await assert.rejects(withProbeDatabase(f.file, f.target, async () => assert.fail(), f.create)); assert.deepEqual(f.calls, []); }
  finally { unlock(); f.close(); }
});
