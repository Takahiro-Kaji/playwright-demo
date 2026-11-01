// 実際のSIGKILL後も要復旧の状態が保存されることを確認する子プロセス。
// DB・AWSの入出力はすべて模擬する。復旧記録とファイルロックは実物を使用する。
import { loadJournal } from '../../tests/aws-sales/environment.ts';
import { Environment } from '../../tests/aws-sales/lifecycle.ts';
import { withProbeDatabase } from './probe-database.ts';

const file = process.argv[2], j = loadJournal(file);
const connection = {
  async query(input: string | {sql: string}) {
    const sql = typeof input === 'string' ? input : input.sql;
    if (sql.includes('GET_LOCK')) return [[{acquired:1}]];
    if (sql.includes('CURRENT_USER')) return [[{db:j.database, principal:`${j.user}@%`}]];
    if (sql.includes('aws_test_owner')) return [[{run_id:j.runId,owner_token:j.owner}]];
    return [[]];
  },
};
const create = () => ({
  async verifyTarget() {},
  async pool() { return { async getConnection() { return connection; } }; },
}) as unknown as Environment;
await withProbeDatabase(file, {
  target:j.config.url, expected:j.config.url, state:j.config.stateFile, selector:'#refresh',
  cognitoDomain:`${j.config.userPoolDomain}.auth.${j.config.region}.amazoncognito.com`,
}, async () => {
  process.send?.('probe-started');
  await new Promise(() => { setInterval(() => {}, 1000); });
}, create);
