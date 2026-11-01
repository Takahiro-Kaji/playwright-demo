import { requireExpectedBatchError } from "../../aws-sales/old/batch/result.ts";
import { test } from "node:test";
import { strict as a } from "node:assert";
import { fixture } from "./fixtures.ts";
import { Environment } from "../../aws-sales/environment/lifecycle.ts";
import { manifests } from "../../aws-sales/environment/resources.ts";
for (const mode of [
  "success",
  "expected",
  "code2",
  "oom",
  "killed",
  "deadline",
  "wait-timeout",
  "state-failure",
  "missing-marker",
  "foreign-pod",
  "startup",
] as const)
  test(`Jobの終了証拠を確認する: ${mode}`, async () => {
    const f = fixture(),
      env = new Environment(f.file, f.j);
    let deleted = false;
    let name = "";
    const uid = "job-uid";
    const job = () => ({
      metadata: { name, uid },
      status: {
        conditions:
          mode === "wait-timeout"
            ? []
            : [
                {
                  type: mode === "success" ? "Complete" : "Failed",
                  status: "True",
                  reason:
                    mode === "deadline"
                      ? "DeadlineExceeded"
                      : "BackoffLimitExceeded",
                },
              ],
      },
    });
    env.cluster.verify = async (kind) =>
      kind === "CronJob" ? manifests(f.j).cron : job();
    env.cluster.create = async (_file, o) => {
      name = o.metadata.name;
      f.j.resources.push({ kind: "Job", name, uid });
      a.equal(o.spec.activeDeadlineSeconds, 180);
      a.equal(o.spec.backoffLimit, 0);
    };
    env.cluster.deleteOwned = async () => {
      deleted = true;
    };
    env.cluster.k = async (args) => {
      if (args[0] === "logs")
        return mode === "missing-marker"
          ? "other failure"
          : "warning\nSALES_START_OR_SYNC_FAILED\n";
      if (deleted) return JSON.stringify({ items: [] });
      if (mode === "state-failure") throw Error("STATUS_READ_FAILED");
      return JSON.stringify({
        items: [
          {
            metadata: {
              name: "batch-pod",
              uid: "pod-uid",
              namespace: f.j.namespace,
              labels: { "sales-run": f.j.runId, "sales-owner": f.j.owner },
              ownerReferences: [
                {
                  name,
                  uid: mode === "foreign-pod" ? "foreign" : uid,
                  kind: "Job",
                  controller: true,
                },
              ],
            },
            spec: manifests(f.j).cron.spec.jobTemplate.spec.template.spec,
            status: {
              containerStatuses: [
                {
                  name: "batch",
                  containerID: "containerd://test",
                  state:
                    mode === "startup"
                      ? { waiting: { reason: "ImagePullBackOff" } }
                      : {
                          terminated: {
                            exitCode:
                              mode === "success"
                                ? 0
                                : mode === "code2"
                                  ? 2
                                  : mode === "oom" || mode === "killed"
                                    ? 137
                                    : 1,
                            reason:
                              mode === "oom"
                                ? "OOMKilled"
                                : mode === "success"
                                  ? "Completed"
                                  : "Error",
                            signal: mode === "killed" ? 9 : 0,
                            startedAt: "2026-01-01T00:00:00Z",
                            finishedAt: "2026-01-01T00:00:01Z",
                          },
                        },
                },
              ],
            },
          },
        ],
      });
    };
    try {
      const r = await env.batches.run(mode === "wait-timeout" ? 0 : 100);
      a.equal(deleted, true);
      a.equal(r.stop, "confirmed");
      const expected =
        mode === "success"
          ? "complete"
          : mode === "expected"
            ? "expected-error"
            : ["deadline", "wait-timeout"].includes(mode)
              ? "timeout"
              : ["state-failure", "foreign-pod"].includes(mode)
                ? "unconfirmed"
                : "unexpected-failure";
      a.equal(r.outcome, expected);
      if (mode === "expected")
        a.doesNotThrow(() => requireExpectedBatchError(r));
      else a.throws(() => requireExpectedBatchError(r));
      if (mode !== "expected") a.notEqual(r.outcome, "expected-error");
      a.equal(f.j.batches?.[0].outcome, expected);
    } finally {
      f.close();
    }
  });
