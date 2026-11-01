import { readFileSync } from "node:fs";
import type { Pool } from "mysql2/promise";
import type { Cluster } from "../environment/cluster.ts";
import {
  assertCondition,
  saveJournal,
  type Journal,
} from "../environment/state.ts";
import { createPodPool } from "./mysql-tunnel.ts";
import { snapshotMysql } from "./rows.ts";

/** 専用DBへの接続・所有確認・スキーマの作成・削除とデータ初期化。 */
export class SalesDatabase {
  readonly file: string;
  readonly j: Journal;
  readonly cluster: Cluster;
  constructor(file: string, j: Journal, cluster: Cluster) {
    this.file = file;
    this.j = j;
    this.cluster = cluster;
  }
  async bridge() {
    const p = await this.cluster.verify("Pod", "sales-db-bridge");
    assertCondition(
      JSON.stringify(p.spec.containers?.[0]?.command) ===
        JSON.stringify(["node", "-e", "setInterval(()=>{},60000)"]) &&
        !p.spec.containers?.[0]?.args &&
        !p.spec.containers?.[0]?.envFrom,
      "BRIDGE_COMMAND_MISMATCH",
    );
    assertCondition(
      p.spec.containers?.[0]?.image === this.j.config.image &&
        p.spec.containers[0].env?.find((e: any) => e.name === "DB_HOST")
          ?.value === this.j.config.dbHost,
      "BRIDGE_CONFIG_MISMATCH",
    );
    assertCondition(
      p.status?.phase === "Running" &&
        p.status?.conditions?.some(
          (c: any) => c.type === "Ready" && c.status === "True",
        ),
      "BRIDGE_NOT_READY",
    );
    return p;
  }
  async pool(admin = false): Promise<Pool> {
    await this.bridge();
    const dbUser = admin ? process.env.AWS_SALES_ADMIN_USER : this.j.user,
      dbPassword = admin
        ? process.env.AWS_SALES_ADMIN_PASSWORD
        : this.j.password;
    assertCondition(dbUser && dbPassword, "ADMIN_CREDENTIALS_REQUIRED");
    return createPodPool(
      {
        runId: this.j.runId,
        context: this.j.config.context,
        pod: "sales-db-bridge",
        dbHost: this.j.config.dbHost,
        dbUser,
        dbPassword,
        caFile: this.j.config.caFile,
      },
      this.j.namespace,
      "bridge",
      admin ? undefined : this.j.database,
    );
  }
  async verifyOwner(pool: Pool) {
    const [rows] = await pool.query<any[]>(
      "SELECT run_id,owner_token FROM aws_test_owner WHERE id=1",
    );
    assertCondition(
      rows.length === 1 &&
        rows[0].run_id === this.j.runId &&
        rows[0].owner_token === this.j.owner,
      "DB_OWNERSHIP_MISMATCH",
    );
  }
  async createSchema() {
    const admin = await this.pool(true);
    try {
      // 既存のDBやユーザーを流用しないよう、IF NOT EXISTSは使わない。
      this.j.dbIntent = true;
      saveJournal(this.file, this.j);
      await admin.query(
        `CREATE DATABASE \`${this.j.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
      );
      this.j.dbCreated = true;
      saveJournal(this.file, this.j);
      await admin.query(
        `CREATE TABLE \`${this.j.database}\`.aws_test_owner (id INT PRIMARY KEY,run_id CHAR(32) NOT NULL,owner_token CHAR(48) NOT NULL)`,
      );
      await admin.execute(
        `INSERT INTO \`${this.j.database}\`.aws_test_owner VALUES (1,?,?)`,
        [this.j.runId, this.j.owner],
      );
      this.j.dbOwned = true;
      saveJournal(this.file, this.j);
      // 初期化にはスキーマを明示した単一の接続を使用する。
      const c = await admin.getConnection();
      try {
        await c.query(`USE \`${this.j.database}\``);
        for (const sql of readFileSync("aws/sales/schema.sql", "utf8")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean))
          await c.query(sql);
      } finally {
        c.release();
      }
      this.j.userIntent = true;
      saveJournal(this.file, this.j);
      await admin.query(
        `CREATE USER '${this.j.user}'@'%' IDENTIFIED BY '${this.j.password}' REQUIRE SSL ATTRIBUTE '{"salesOwner":"${this.j.owner}"}'`,
      );
      this.j.userCreated = true;
      saveJournal(this.file, this.j);
      for (const table of [
        "products",
        "inventory",
        "orders",
        "sync_state",
        "sales_lock",
      ])
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE,DELETE ON \`${this.j.database}\`.${table} TO '${this.j.user}'@'%'`,
        );
      await admin.query(
        `GRANT SELECT ON \`${this.j.database}\`.aws_test_owner TO '${this.j.user}'@'%'`,
      );
    } finally {
      await admin.end();
    }
  }
  async reset(pool: Pool) {
    await this.verifyOwner(pool);
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.query<any[]>(
        "SELECT id FROM sales_lock WHERE id=1 FOR UPDATE",
      );
      assertCondition(rows.length === 1, "SCHEMA_LOCK_MISSING");
      for (const table of ["orders", "inventory", "products", "sync_state"])
        await c.query(`DELETE FROM ${table}`);
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
    const s = await snapshotMysql(pool);
    assertCondition(
      Object.values(s).every((v: any) => v.length === 0),
      "EMPTY_DB_UNCONFIRMED",
    );
  }

  /** 呼び出し元で全writerの停止とnamespaceの所有関係を確認した後にのみ使う。 */
  async dropSchema() {
    const { j } = this;
    const admin = await this.pool(true);
    try {
      if (j.dbCreated || j.dbIntent) {
        const [schemas] = await admin.execute<any[]>(
          "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
          [j.database],
        );
        if (!schemas.length) {
          j.dbCreated = false;
          j.dbOwned = false;
          j.dbIntent = false;
          saveJournal(this.file, this.j);
        }
      }
      if (j.dbCreated || j.dbIntent) {
        assertCondition(
          j.dbOwned,
          "DB_OWNER_MARKER_MISSING_MANUAL_REVIEW_REQUIRED",
        );
        const [owner] = await admin.query<any[]>(
          `SELECT run_id,owner_token FROM \`${j.database}\`.aws_test_owner WHERE id=1`,
        );
        assertCondition(
          owner.length === 1 &&
            owner[0].run_id === j.runId &&
            owner[0].owner_token === j.owner,
          "DB_OWNERSHIP_MISMATCH",
        );
      }
      if (j.userCreated || j.userIntent) {
        const [users] = await admin.execute<any[]>(
          "SELECT User,Host,JSON_UNQUOTE(JSON_EXTRACT(User_attributes,'$.metadata.salesOwner')) AS owner FROM mysql.user WHERE User=? AND Host='%'",
          [j.user],
        );
        assertCondition(
          users.length === 0 ||
            (users.length === 1 && users[0].owner === j.owner),
          "DB_USER_OWNERSHIP_MISMATCH",
        );
        if (users.length) await admin.query(`DROP USER '${j.user}'@'%'`);
        const [remaining] = await admin.execute<any[]>(
          "SELECT User FROM mysql.user WHERE User=? AND Host='%'",
          [j.user],
        );
        assertCondition(remaining.length === 0, "DB_USER_DROP_UNCONFIRMED");
        j.userCreated = false;
        j.userIntent = false;
        saveJournal(this.file, this.j);
      }
      if (j.dbCreated) {
        await admin.query(`DROP DATABASE \`${j.database}\``);
        const [remaining] = await admin.execute<any[]>(
          "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
          [j.database],
        );
        assertCondition(remaining.length === 0, "DB_DROP_UNCONFIRMED");
        j.dbCreated = false;
        j.dbOwned = false;
        j.dbIntent = false;
        saveJournal(this.file, this.j);
      }
    } finally {
      await admin.end();
    }
  }
}
