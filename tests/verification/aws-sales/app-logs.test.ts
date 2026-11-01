import { test } from "node:test";
import { strict as a } from "node:assert";
import { readFileSync, rmSync, statSync } from "node:fs";
import { Cluster } from "../../aws-sales/environment/cluster.ts";
import { collectAppLogs } from "../../aws-sales/support/app-logs.ts";
import { fixture } from "./fixtures.ts";

for (const mode of [
  "restarted",
  "foreign-pod",
  "foreign-rs",
  "logs-failed",
  "missing",
] as const) {
  test(`アプリログの保存と所有関係・失敗の扱い: ${mode}`, async () => {
    const f = fixture();
    const cluster = new Cluster(f.j);
    const calls: string[][] = [];
    cluster.verify = async () => ({ metadata: { uid: "deployment" } });
    cluster.get = async () => ({
      metadata: {
        uid: "rs",
        ownerReferences: [
          {
            kind: "Deployment",
            uid: mode === "foreign-rs" ? "other" : "deployment",
            controller: true,
          },
        ],
      },
    });
    cluster.k = async (args) => {
      calls.push(args);
      if (args[0] === "logs") {
        if (mode === "logs-failed") throw Error("UNAVAILABLE");
        return args.includes("--previous") ? "previous log\n" : "current log\n";
      }
      return JSON.stringify({
        items:
          mode === "missing"
            ? []
            : [
                {
                  metadata: {
                    name: "sales-app-test",
                    labels: {
                      "sales-run": mode === "foreign-pod" ? "other" : f.j.runId,
                      "sales-owner": f.j.owner,
                    },
                    ownerReferences: [
                      {
                        kind: "ReplicaSet",
                        name: "sales-app-rs",
                        uid: "rs",
                        controller: true,
                      },
                    ],
                  },
                  status: {
                    phase: "Failed",
                    containerStatuses: [{ name: "app", restartCount: 1 }],
                  },
                },
              ],
      });
    };
    try {
      const since = "2026-11-02T00:00:00.000Z";
      const result = await collectAppLogs(cluster, "UI-01", since);
      a.equal(result.status, mode === "restarted" ? "saved" : "failed");
      if (mode === "restarted") {
        a.equal(result.files.length, 2);
        a.equal(readFileSync(result.files[0], "utf8"), "current log\n");
        a.equal(readFileSync(result.files[1], "utf8"), "previous log\n");
        for (const path of result.files) {
          a.ok(
            path.startsWith(
              `.local/aws-sales-evidence/${f.j.runId}/app-logs/UI-01-`,
            ),
          );
          a.equal(statSync(path).mode & 0o777, 0o600);
        }
        a.ok(
          calls
            .filter((c) => c[0] === "logs")
            .every(
              (c) =>
                c.includes(`--since-time=${since}`) &&
                c.includes("--timestamps=true") &&
                c.includes("--limit-bytes=1048576"),
            ),
        );
      } else {
        a.deepEqual(result.files, []);
        if (mode !== "logs-failed") a.ok(!calls.some((c) => c[0] === "logs"));
      }
    } finally {
      rmSync(`.local/aws-sales-evidence/${f.j.runId}`, {
        recursive: true,
        force: true,
      });
      f.close();
    }
  });
}
