import { test } from "node:test";
import { strict as a } from "node:assert";
import { Environment } from "../../aws-sales/environment/lifecycle.ts";
import { loadJournal, saveJournal } from "../../aws-sales/environment/state.ts";
import { fixture } from "./fixtures.ts";

for (const operation of ["CREATE DATABASE", "CREATE USER"]) {
  test(`DB準備の応答喪失後も作成意図を残し接続を回収する: ${operation}`, async () => {
    const f = fixture();
    const env = new Environment(f.file, f.j);
    let ended = false;
    let released = false;
    env.database.pool = async () =>
      ({
        async query(sql: string) {
          if (sql.startsWith(operation)) throw Error("RESPONSE_LOST");
        },
        async execute() {},
        async getConnection() {
          return {
            async query() {},
            release() {
              released = true;
            },
          };
        },
        async end() {
          ended = true;
        },
      }) as any;
    try {
      await a.rejects(env.database.createSchema(), /RESPONSE_LOST/);
      const recorded = loadJournal(f.file);
      a.equal(recorded.dbIntent, true);
      a.equal(recorded.dbCreated, operation === "CREATE USER");
      a.equal(recorded.dbOwned, operation === "CREATE USER");
      a.equal(Boolean(recorded.userIntent), operation === "CREATE USER");
      a.equal(recorded.userCreated, false);
      a.equal(ended, true);
      a.equal(released, operation === "CREATE USER");
    } finally {
      f.close();
    }
  });
}

for (const failure of ["foreign-owner", "drop-response-lost"]) {
  test(`DB削除の未確認状態を保持し追加の削除へ進まない: ${failure}`, async () => {
    const f = fixture();
    Object.assign(f.j, {
      dbIntent: true,
      dbCreated: true,
      dbOwned: true,
      userIntent: true,
      userCreated: true,
      blocked: true,
    });
    saveJournal(f.file, f.j);
    const env = new Environment(f.file, f.j);
    const dropped: string[] = [];
    let ended = false;
    env.database.pool = async () =>
      ({
        async execute(sql: string) {
          if (sql.includes("SCHEMATA"))
            return [[{ SCHEMA_NAME: f.j.database }]];
          return [[{ owner: f.j.owner }]];
        },
        async query(sql: string) {
          if (sql.startsWith("DROP")) {
            dropped.push(sql);
            throw Error("RESPONSE_LOST");
          }
          return [
            [
              {
                run_id: f.j.runId,
                owner_token:
                  failure === "foreign-owner" ? "other-owner" : f.j.owner,
              },
            ],
          ];
        },
        async end() {
          ended = true;
        },
      }) as any;
    try {
      await a.rejects(
        env.database.dropSchema(),
        failure === "foreign-owner" ? /DB_OWNERSHIP_MISMATCH/ : /RESPONSE_LOST/,
      );
      a.equal(dropped.length, failure === "foreign-owner" ? 0 : 1);
      a.ok(dropped.every((sql) => sql.startsWith("DROP USER")));
      const recorded = loadJournal(f.file);
      a.equal(recorded.dbCreated, true);
      a.equal(recorded.userCreated, true);
      a.equal(recorded.blocked, true);
      a.equal(ended, true);
    } finally {
      f.close();
    }
  });
}
