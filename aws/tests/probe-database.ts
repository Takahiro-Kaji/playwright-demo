import type { Connection, Pool, PoolConnection } from 'mysql2/promise';
import { resolve } from 'node:path';
import { exclusive, loadJournal, saveJournal, requireThat, errorCodes, type Journal } from '../../tests/aws-sales/environment.ts';
import { Environment } from '../../tests/aws-sales/lifecycle.ts';
import { acquireTestLock, releaseTestLock } from '../../tests/aws-sales/db.ts';
import type { awsSsoConfig } from '../../tests/aws-sales/config.ts';

type Target = ReturnType<typeof awsSsoConfig>;

export function checkProbeTarget(j: Journal, c: Target) {
  requireThat(j.phase === 'prepared' && !j.blocked && j.dbOwned && j.dbCreated && j.userCreated, 'PROBE_JOURNAL_NOT_READY');
  requireThat(c.target === j.config.url && c.expected === j.config.url &&
    resolve(c.state) === resolve(j.config.stateFile) &&
    c.cognitoDomain === `${j.config.userPoolDomain}.auth.${j.config.region}.amazoncognito.com`, 'PROBE_TARGET_MISMATCH');
}

/** No direct TCP or admin fallback. Hold both journal and DB locks until After finishes. */
export async function withProbeDatabase(
  file: string | undefined,
  target: Target,
  action: (db: Connection) => Promise<void>,
  create = (file: string, j: Journal) => new Environment(file, j),
) {
  requireThat(file, 'PROBE_JOURNAL_REQUIRED');
  const unlock = exclusive(file);
  let pool: Pool | undefined;
  let connection: PoolConnection | undefined;
  let journal: Journal | undefined;
  const failures: unknown[] = [];
  try {
    const j = journal = loadJournal(file);
    checkProbeTarget(j, target);
    const env = create(file, j);
    // Includes AWS/context identity, owned Pods/Secrets/CA, UI -> ALB -> app -> DB.
    await env.verifyTarget();
    pool = await env.pool();
    connection = await acquireTestLock(pool);
    await connection.query({ sql: 'SET SESSION innodb_lock_wait_timeout = 10', timeout: 10_000 });
    const [rows] = await connection.query<any[]>({ sql: 'SELECT DATABASE() AS db, CURRENT_USER() AS principal', timeout: 10_000 });
    requireThat(rows.length === 1 && rows[0].db === j.database && rows[0].principal === `${j.user}@%`, 'PROBE_DATABASE_MISMATCH');
    const [owners] = await connection.query<any[]>({ sql: 'SELECT run_id,owner_token FROM aws_test_owner WHERE id=1', timeout: 10_000 });
    requireThat(owners.length === 1 && owners[0].run_id === j.runId && owners[0].owner_token === j.owner, 'DB_OWNERSHIP_MISMATCH');
    await action(connection);
  } catch (error) { failures.push(error); }
  finally {
    try { if (connection) await releaseTestLock(connection); } catch (error) { failures.push(error); }
    try { if (pool) await pool.end(); } catch { failures.push(Error('PROBE_DB_CLOSE_FAILED')); }
    try {
      if (journal && failures.length) {
        const codes = failures.flatMap(errorCodes);
        journal.lastErrors = [...new Set([...(journal.lastErrors || []), ...codes])];
        if (codes.some(code => /CLEANUP|LOCK_LOST|CLOSE_FAILED/.test(code))) journal.blocked = true;
        saveJournal(file, journal);
      }
    } finally { unlock(); }
  }
  // mysql2/HTTP errors may contain credentials or rows. Expose only fixed codes.
  if (failures.length) throw new AggregateError(
    failures.flatMap(errorCodes).map(code => Error(code)), 'PROBE_DATABASE_OR_CHECK_FAILED',
  );
}
