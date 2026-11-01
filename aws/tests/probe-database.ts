import type { Connection, Pool, PoolConnection } from 'mysql2/promise';
import { resolve } from 'node:path';
import { exclusive, loadJournal, saveJournal, assertCondition, errorCodes, type Journal } from '../../tests/aws-sales/environment/state.ts';
import { Environment } from '../../tests/aws-sales/environment/lifecycle.ts';
import { acquireTestLock, releaseTestLock } from '../../tests/aws-sales/database/test-lock.ts';
import type { awsSsoConfig } from '../../tests/aws-sales/support/auth-config.ts';

type Target = ReturnType<typeof awsSsoConfig>;

export function checkProbeTarget(j: Journal, c: Target) {
  assertCondition(j.phase === 'prepared' && !j.blocked && j.dbOwned && j.dbCreated && j.userCreated, 'PROBE_JOURNAL_NOT_READY');
  assertCondition(c.target === j.config.url && c.expected === j.config.url &&
    resolve(c.state) === resolve(j.config.stateFile) &&
    c.cognitoDomain === `${j.config.userPoolDomain}.auth.${j.config.region}.amazoncognito.com`, 'PROBE_TARGET_MISMATCH');
}

/** 直接TCP接続や管理者接続への切り替えは行わない。後処理が終わるまで復旧記録とDBの両ロックを保持する。 */
export async function withProbeDatabase(
  file: string | undefined,
  target: Target,
  action: (db: Connection) => Promise<void>,
  create = (file: string, j: Journal) => new Environment(file, j),
) {
  assertCondition(file, 'PROBE_JOURNAL_REQUIRED');
  const unlock = exclusive(file);
  let pool: Pool | undefined;
  let connection: PoolConnection | undefined;
  let journal: Journal | undefined;
  let recoveryStarted = false;
  const failures: unknown[] = [];
  try {
    const j = journal = loadJournal(file);
    checkProbeTarget(j, target);
    // 確認用接続を含むDB操作の前に記録を保存する。プロセスが強制終了した場合は、
    // 残ったファイルロックを削除した後も復旧を必須にする。
    j.blocked = true;
    j.phase = 'recovery-required';
    saveJournal(file, j);
    recoveryStarted = true;
    const env = create(file, j);
    // AWS・接続コンテキストの識別情報、所有するPod・Secret・CA、UI→ALB→アプリ→DBの経路を確認する。
    await env.target.verifyUi();
    pool = await env.database.pool();
    connection = await acquireTestLock(pool);
    await connection.query({ sql: 'SET SESSION innodb_lock_wait_timeout = 10', timeout: 10_000 });
    const [rows] = await connection.query<any[]>({ sql: 'SELECT DATABASE() AS db, CURRENT_USER() AS principal', timeout: 10_000 });
    assertCondition(rows.length === 1 && rows[0].db === j.database && rows[0].principal === `${j.user}@%`, 'PROBE_DATABASE_MISMATCH');
    const [owners] = await connection.query<any[]>({ sql: 'SELECT run_id,owner_token FROM aws_test_owner WHERE id=1', timeout: 10_000 });
    assertCondition(owners.length === 1 && owners[0].run_id === j.runId && owners[0].owner_token === j.owner, 'DB_OWNERSHIP_MISMATCH');
    await action(connection);
  } catch (error) { failures.push(error); }
  finally {
    try { if (connection) await releaseTestLock(connection); } catch (error) { failures.push(error); }
    try { if (pool) await pool.end(); } catch { failures.push(Error('PROBE_DB_CLOSE_FAILED')); }
    try {
      if (journal && (recoveryStarted || failures.length)) {
        const codes = failures.flatMap(errorCodes);
        journal.lastErrors = [...new Set([...(journal.lastErrors || []), ...codes])];
        // 検証と後処理、ロック解放、接続プール終了がすべて成功した場合のみ再利用を許可する。
        // エラー名にかかわらず、失敗した場合は要復旧の状態を保持する。
        if (recoveryStarted && failures.length === 0) {
          journal.blocked = false;
          journal.phase = 'prepared';
        }
        saveJournal(file, journal);
      }
    } finally { unlock(); }
  }
  // mysql2・HTTPのエラーには認証情報や行データが含まれ得るため、固定コードのみ表示する。
  if (failures.length) throw new AggregateError(
    failures.flatMap(errorCodes).map(code => Error(code)), 'PROBE_DATABASE_OR_CHECK_FAILED',
  );
}
