'use strict';
const { query } = require('../../../helpers/mysql.cjs');
async function snapshotItems(testKey) {
  const sql = "SELECT JSON_OBJECT('id', CAST(id AS CHAR), 'testKey', test_key, 'status', status, 'createdAt', CAST(created_at AS CHAR)) FROM items WHERE test_key = @test_key ORDER BY id;";
  const stdout = await query(testKey, sql);
  return stdout ? stdout.split('\n').map((line) => JSON.parse(line)) : [];
}
module.exports = { snapshotItems };
