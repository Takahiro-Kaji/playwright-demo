import { test } from "node:test";
import { strict as a } from "node:assert";
import { fixture } from "./fixtures.ts";
import { Environment } from "../../aws-sales/lifecycle.ts";
import { cleanup } from "../../aws-sales/cleanup.ts";
for (const mode of [
  "app-failure",
  "pod-timeout",
  "job-failure",
  "success",
] as const)
  test(`後片付け前に書き込み処理の停止を確認する: ${mode}`, async () => {
    const f = fixture(),
      env = new Environment(f.file, f.j),
      calls: string[] = [];
    f.j.dbOwned = true;
    f.j.lastErrors = ["ORIGINAL_BODY_FAILURE"];
    const dep = { metadata: { managedFields: [] }, spec: { replicas: 1 } };
    env.cluster.identity = async () => ({});
    env.cluster.get = async (kind, name) =>
      kind === "Namespace"
        ? {}
        : kind === "Deployment"
          ? structuredClone(dep)
          : undefined;
    env.cluster.verify = async () => structuredClone(dep);
    env.cluster.owned = (o) => o;
    env.stopJobs = async () => {
      a.equal(f.j.blocked, true);
      a.equal(f.j.phase, "cleaning");
      calls.push("stop-jobs");
      if (mode === "job-failure") throw Error("INJECTED_JOB_STOP_FAILURE");
    };
    env.cluster.k = async (args, input) => {
      if (args[0] === "api-resources") return "";
      if (args[0] === "replace" && (input as any)?.spec?.replicas === 0) {
        calls.push("stop-app");
        if (mode === "app-failure") throw Error("INJECTED_APP_STOP_FAILURE");
      }
      if (
        args[1] === "pods" &&
        args.includes("app=sales-app") &&
        mode === "pod-timeout"
      )
        return JSON.stringify({ items: [{}] });
      return JSON.stringify({ items: [] });
    };
    env.cluster.aws = async (_s, op) =>
      op === "describe-load-balancers"
        ? { LoadBalancers: [] }
        : { TargetGroups: [] };
    env.rollout = async () => {};
    env.pool = async () => {
      calls.push("pool");
      return {
        getConnection: async () => ({
          query: async (sql: string) => [
            [sql.includes("GET_LOCK") ? { acquired: 1 } : { released: 1 }],
          ],
          release() {},
          destroy() {},
        }),
        end: async () => {
          calls.push("end");
        },
      } as any;
    };
    env.restore = async () => {
      calls.push("restore");
    };
    env.reset = async () => {
      calls.push("reset");
    };
    env.deleteOwned = async () => {
      calls.push("delete");
    };
    try {
      if (mode === "success") {
        await cleanup(env, { stopTimeoutMs: 1 });
        a.ok(calls.includes("restore"));
        a.ok(calls.includes("delete"));
        a.equal(f.j.phase, "cleaned");
      } else {
        await a.rejects(cleanup(env, { stopTimeoutMs: 1 }));
        a.ok(
          !calls.some((c) =>
            ["pool", "restore", "reset", "delete"].includes(c),
          ),
        );
        a.equal(f.j.blocked, true);
        a.equal(f.j.phase, "recovery-required");
        a.ok(f.j.lastErrors?.includes("ORIGINAL_BODY_FAILURE"));
        a.ok(f.j.cleanupStops?.reasons.length);
        a.ok(calls.includes("stop-app"));
      }
    } finally {
      f.close();
    }
  });
