import { randomBytes } from "node:crypto";
import type { Cluster } from "../../environment/cluster.ts";
import {
  assertCondition,
  saveJournal,
  type Journal,
} from "../../environment/state.ts";
import { checkEnv } from "../../environment/workloads.ts";
import { pause } from "../../support/polling.ts";
import {
  terminationEvidence,
  classifyBatch,
  type BatchResult,
} from "./result.ts";

/** Jobの開始・終了証拠の採取・停止確認を一つの実行単位として扱う。 */
export class BatchRunner {
  readonly file: string;
  readonly j: Journal;
  readonly cluster: Cluster;
  constructor(file: string, j: Journal, cluster: Cluster) {
    this.file = file;
    this.j = j;
    this.cluster = cluster;
  }
  async run(waitMs = 190000): Promise<BatchResult> {
    const cron = await this.cluster.verify("CronJob", "sales-batch");
    checkEnv(cron.spec.jobTemplate.spec.template.spec.containers[0], this.j);
    const name = `sales-sync-${randomBytes(10).toString("hex")}`;
    const object = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: this.cluster.metadata(name),
      spec: structuredClone(cron.spec.jobTemplate.spec),
    };
    object.spec.template.metadata = {
      labels: this.cluster.metadata(name).labels,
    };
    object.spec.activeDeadlineSeconds = 180;
    object.spec.backoffLimit = 0;
    const result: BatchResult = {
      job: name,
      outcome: "unconfirmed",
      codes: [],
      stop: "pending",
    };
    let bodyError: unknown;
    let terminalJob: any;
    let waitTimeout = true;
    try {
      await this.cluster.create(this.file, object);
      const end = performance.now() + waitMs;
      while (performance.now() < end) {
        const job = await this.cluster.verify("Job", name),
          conditions = job.status?.conditions || [];
        if (
          conditions.some(
            (x: any) => x.type === "Complete" && x.status === "True",
          )
        ) {
          terminalJob = job;
          result.jobReason = "Complete";
          waitTimeout = false;
          break;
        }
        const failed = conditions.find(
          (x: any) => x.type === "Failed" && x.status === "True",
        );
        if (failed) {
          terminalJob = job;
          result.jobReason =
            failed.reason === "DeadlineExceeded"
              ? "DeadlineExceeded"
              : failed.reason === "BackoffLimitExceeded"
                ? "BackoffLimitExceeded"
                : "OtherFailure";
          waitTimeout = false;
          break;
        }
        await pause(250);
      }
      if (waitTimeout) result.jobReason = "WaitTimeout";
      try {
        const job = terminalJob || (await this.cluster.verify("Job", name));
        result.uid = job.metadata.uid;
        const pods = JSON.parse(
          await this.cluster.k([
            "get",
            "pods",
            "-l",
            `job-name=${name}`,
            "-o",
            "json",
          ]),
        ).items;
        // 所有関係とコマンドを検証してから、件数を制限してログ末尾を取得する。
        result.termination = terminationEvidence(this.j, job, pods, false);
        if (result.termination.exitCode === 1) {
          const logs = await this.cluster.k([
            "logs",
            result.termination.pod,
            "-c",
            "batch",
            "--tail=8",
            "--limit-bytes=2048",
          ]);
          result.termination.failureMarker = logs
            .split(/\r?\n/)
            .some((line) => line === "SALES_START_OR_SYNC_FAILED");
        }
        result.outcome = classifyBatch(job, result.termination, waitTimeout);
      } catch {
        result.outcome =
          waitTimeout ||
          terminalJob?.status?.conditions?.some(
            (c: any) => c.type === "Failed" && c.reason === "DeadlineExceeded",
          )
            ? "timeout"
            : "unconfirmed";
        result.codes.push("BATCH_EXIT_EVIDENCE_UNCONFIRMED");
      }
    } catch (e) {
      bodyError = e;
      result.codes.push("JOB_OPERATION_FAILED");
    }
    if (result.outcome === "unexpected-failure")
      result.codes.push("UNEXPECTED_BATCH_TERMINATION");
    if (result.termination?.reason === "OOMKilled")
      result.codes.push("BATCH_OOM");
    if (result.termination?.signal) result.codes.push("BATCH_SIGNAL_EXIT");
    if (result.termination && !result.termination.started)
      result.codes.push("BATCH_NOT_EXECUTED");
    (this.j.batches ??= []).push(result);
    saveJournal(this.file, this.j);
    let afterError: unknown;
    try {
      await this.cluster.deleteOwned("Job", name);
      const pods = JSON.parse(
        await this.cluster.k([
          "get",
          "pods",
          "-l",
          `job-name=${name}`,
          "-o",
          "json",
        ]),
      );
      assertCondition(pods.items.length === 0, "JOB_PODS_STOP_UNCONFIRMED");
      result.stop = "confirmed";
    } catch (e) {
      afterError = e;
      result.stop = "unconfirmed";
      result.codes.push("JOB_STOP_UNCONFIRMED");
      this.j.blocked = true;
      saveJournal(this.file, this.j);
    }
    saveJournal(this.file, this.j);
    if (bodyError || afterError)
      throw new AggregateError(
        [
          ...(bodyError
            ? [new AggregateError([bodyError], "JOB_OPERATION_FAILED")]
            : []),
          ...(afterError
            ? [new AggregateError([afterError], "JOB_STOP_UNCONFIRMED")]
            : []),
        ],
        "BATCH_OPERATION_OR_STOP_FAILED",
      );
    return result;
  }
  async stopAll() {
    const failures: unknown[] = [];
    for (const r of this.j.resources.filter((r) => r.kind === "Job"))
      try {
        await this.cluster.deleteOwned("Job", r.name);
        const pods = JSON.parse(
          await this.cluster.k([
            "get",
            "pods",
            "-l",
            `job-name=${r.name}`,
            "-o",
            "json",
          ]),
        );
        assertCondition(pods.items.length === 0, "JOB_PODS_STOP_UNCONFIRMED");
      } catch (e) {
        failures.push(e);
      }
    if (failures.length)
      throw new AggregateError(failures, "JOB_STOP_UNCONFIRMED");
  }
}
