import { assertCondition, type Journal } from "./environment.ts";
import { checkEnv } from "./lifecycle.ts";
export type BatchResult = {
  job: string;
  uid?: string;
  outcome:
    | "complete"
    | "expected-error"
    | "unexpected-failure"
    | "timeout"
    | "unconfirmed";
  codes: string[];
  jobReason?:
    | "Complete"
    | "BackoffLimitExceeded"
    | "DeadlineExceeded"
    | "OtherFailure"
    | "WaitTimeout";
  stop: "pending" | "confirmed" | "unconfirmed";
  termination?: {
    pod: string;
    uid: string;
    exitCode?: number;
    reason: string;
    signal?: number;
    started: boolean;
    finished: boolean;
    failureMarker: boolean;
  };
};
/** 状態フィールドは長さを制限して保持し、既定の固定エラーマーカーは有無のみ保持する。 */
export function terminationEvidence(
  j: Journal,
  job: any,
  pods: any[],
  marker: boolean,
): NonNullable<BatchResult["termination"]> {
  assertCondition(pods.length === 1, "BATCH_POD_COUNT_UNCONFIRMED");
  const p = pods[0];
  assertCondition(
    p.metadata.namespace === j.namespace &&
      p.metadata.labels?.["sales-owner"] === j.owner &&
      p.metadata.labels?.["sales-run"] === j.runId &&
      p.metadata.ownerReferences?.some(
        (o: any) =>
          o.kind === "Job" &&
          o.uid === job.metadata.uid &&
          o.name === job.metadata.name &&
          o.controller === true,
      ),
    "BATCH_POD_OWNER_MISMATCH",
  );
  assertCondition(
    p.spec.containers?.length === 1 && p.spec.containers[0].name === "batch",
    "BATCH_CONTAINER_MISMATCH",
  );
  checkEnv(p.spec.containers[0], j);
  assertCondition(
    JSON.stringify(p.spec.containers[0].command) ===
      JSON.stringify(["node", "aws/sales/runtime.ts", "batch"]),
    "BATCH_COMMAND_MISMATCH",
  );
  const states = p.status?.containerStatuses?.filter(
    (s: any) => s.name === "batch",
  );
  assertCondition(states?.length === 1, "BATCH_CONTAINER_STATUS_UNCONFIRMED");
  const t = states[0].state?.terminated;
  if (!t)
    return {
      pod: p.metadata.name,
      uid: p.metadata.uid,
      reason: [
        "ImagePullBackOff",
        "ErrImagePull",
        "CreateContainerConfigError",
        "CreateContainerError",
        "RunContainerError",
        "CrashLoopBackOff",
        "InvalidImageName",
      ].includes(states[0].state?.waiting?.reason)
        ? states[0].state.waiting.reason
        : states[0].state?.waiting
          ? "Waiting"
          : "Running",
      started: Boolean(
        states[0].state?.running?.startedAt && states[0].containerID,
      ),
      finished: false,
      failureMarker: false,
    };
  assertCondition(Number.isInteger(t.exitCode), "BATCH_EXIT_CODE_UNCONFIRMED");
  return {
    pod: p.metadata.name,
    uid: p.metadata.uid,
    exitCode: t.exitCode,
    signal: t.signal ?? 0,
    reason: [
      "Completed",
      "Error",
      "OOMKilled",
      "ContainerCannotRun",
      "StartError",
    ].includes(t.reason)
      ? t.reason
      : "Other",
    started:
      Number.isFinite(Date.parse(t.startedAt)) &&
      Date.parse(t.startedAt) > 0 &&
      Boolean(states[0].containerID),
    finished:
      Number.isFinite(Date.parse(t.finishedAt)) && Date.parse(t.finishedAt) > 0,
    failureMarker: marker,
  };
}
export function classifyBatch(
  job: any,
  e: BatchResult["termination"],
  waitTimeout: boolean,
): BatchResult["outcome"] {
  const c = job.status?.conditions || [];
  if (
    waitTimeout ||
    c.some(
      (v: any) =>
        v.type === "Failed" &&
        v.status === "True" &&
        v.reason === "DeadlineExceeded",
    )
  )
    return "timeout";
  if (
    e &&
    [
      "ImagePullBackOff",
      "ErrImagePull",
      "CreateContainerConfigError",
      "CreateContainerError",
      "RunContainerError",
      "CrashLoopBackOff",
      "InvalidImageName",
    ].includes(e.reason)
  )
    return "unexpected-failure";
  if (!e || !e.started || !e.finished || e.exitCode === undefined)
    return "unconfirmed";
  if (
    c.some((v: any) => v.type === "Complete" && v.status === "True") &&
    e.exitCode === 0 &&
    e.reason === "Completed" &&
    !e.signal
  )
    return "complete";
  if (
    c.some(
      (v: any) =>
        v.type === "Failed" &&
        v.status === "True" &&
        v.reason === "BackoffLimitExceeded",
    ) &&
    e.exitCode === 1 &&
    e.reason === "Error" &&
    !e.signal &&
    e.failureMarker
  )
    return "expected-error";
  return "unexpected-failure";
}

/** BATCH-02の判定条件。単なるFailed状態だけでは条件を満たさない。 */
export function requireExpectedBatchError(result: BatchResult) {
  const e = result.termination;
  assertCondition(
    result.outcome === "expected-error" &&
      result.stop === "confirmed" &&
      e?.started &&
      e.finished &&
      e.exitCode === 1 &&
      e.reason === "Error" &&
      !e.signal &&
      e.failureMarker,
    "EXPECTED_BATCH_ERROR",
  );
}
