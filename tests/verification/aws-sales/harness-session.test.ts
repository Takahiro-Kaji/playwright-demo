import { test } from "node:test";
import { strict as a } from "node:assert";
import type { TestInfo } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { HarnessSession } from "../../aws-sales/harness-session.ts";
import { Environment } from "../../aws-sales/lifecycle.ts";
import { fixture } from "./fixtures.ts";

for (const failure of ["reset", "lost-lock", "restore"]) {
  test(`準備・復元を分離しても失敗時に資源と復旧記録を回収する: ${failure}`, async () => {
    const f = fixture();
    f.j.phase = "prepared";
    writeFileSync(f.file, JSON.stringify(f.j));
    const calls: string[] = [];
    let held = true;
    const connection = {
      async query(sql: string) {
        if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
        if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
        return [[{ held: held ? 1 : 0 }]];
      },
      release() {
        calls.push("release");
      },
      destroy() {
        calls.push("destroy");
      },
    };
    class FakeEnvironment extends Environment {
      async verifyBatchTarget() {}
      async pool() {
        return {
          getConnection: async () => connection,
          end: async () => {
            calls.push("end");
          },
        } as any;
      }
      async dbOwner() {}
      async catalog() {}
      async reset() {
        if (failure === "reset") throw Error("RESET_FAILED");
      }
      async restore() {
        calls.push("restore");
        if (failure === "restore") throw Error("RESTORE_FAILED");
      }
      async stopJobs() {
        calls.push("stopJobs");
      }
    }
    const session = new HarnessSession(
      f.file,
      (file, j) => new FakeEnvironment(file, j),
    );
    const info = {
      title: "BATCH-01 recovery",
      annotations: [],
    } as unknown as TestInfo;
    try {
      session.initialize();
      if (failure === "reset") {
        await a.rejects(session.prepare(), /RESET_FAILED/);
        session.markFailed();
        await session.finish(info);
        a.deepEqual(calls, ["restore", "release", "end"]);
      } else {
        const h = await session.prepare();
        h.verdict = "passed";
        h.afterActions.push(async () => {
          calls.push("afterAction");
        });
        if (failure === "lost-lock") held = false;
        await a.rejects(session.finish(info), /AWS_AFTER_FAILED/);
        a.deepEqual(
          calls,
          failure === "lost-lock"
            ? ["destroy", "stopJobs", "release", "end"]
            : ["afterAction", "restore", "release", "end"],
        );
      }
      const journal = JSON.parse(readFileSync(f.file, "utf8"));
      a.equal(journal.blocked, failure !== "reset");
      a.equal(journal.results.length, 1);
      a.equal(
        journal.results[0].verdict,
        failure === "reset" ? "failed" : "passed",
      );
      a.equal(
        journal.results[0].after,
        failure === "reset" ? "confirmed" : "failed",
      );
      a.ok(
        journal.results[0].codes.includes(
          failure === "reset" ? "SETUP_OR_BODY_FAILED" : "AFTER_FAILED",
        ),
      );
      a.equal(info.annotations[2].type, "safe-codes");
    } finally {
      f.close();
    }
  });
}
