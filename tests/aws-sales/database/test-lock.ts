import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

// 両リージョンのテスト実行間で協調ロックを共有する。
// 通常のアプリ通信は排除できないため、テスト環境自体の隔離も必要。
export async function acquireTestLock(pool: Pool): Promise<PoolConnection> {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK('sales-aws-business-tests', 0) AS acquired",
    );
    if (rows[0]?.acquired !== 1) throw Error("AWS_TEST_LOCK_UNAVAILABLE");
    return connection;
  } catch (error) {
    // 応答を失ってもGET_LOCKが成功している可能性があるため、この接続は再利用しない。
    try {
      connection.destroy();
    } catch {
      /* ロック取得時のエラーを保持する */
    }
    throw error;
  }
}
export async function releaseTestLock(connection: PoolConnection) {
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT RELEASE_LOCK('sales-aws-business-tests') AS released",
    );
    if (rows[0]?.released !== 1) throw Error("AWS_TEST_LOCK_LOST");
  } catch (error) {
    // 応答を失った場合、サーバー側でロックが解放されたとは確認できない。
    try {
      connection.destroy();
    } catch {
      /* ロック解放時のエラーを保持する */
    }
    throw error;
  }
  connection.release();
}
/** 変更前に、保持中のセッションが引き続き協調ロックを所有していることを確認する。 */
export async function verifyTestLock(connection: PoolConnection) {
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT IS_USED_LOCK('sales-aws-business-tests')=CONNECTION_ID() AS held",
    );
    if (rows[0]?.held !== 1) throw Error("AWS_TEST_LOCK_LOST");
  } catch (error) {
    try {
      connection.destroy();
    } catch {}
    throw error;
  }
}
