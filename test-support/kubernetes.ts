import { spawn } from "node:child_process";
const namePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export type JobTarget = { context: string; namespace: string; job: string };
export type CommandResult = { stdout: string; stderr: string; code: number };
export type Runner = (
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;
export function makeRunner(binary = "kubectl"): Runner {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      const p = spawn(binary, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill("SIGKILL");
      }, timeoutMs);
      p.stdout.on("data", (b) => {
        stdout += b.toString();
        if (stdout.length > 1_000_000) p.kill("SIGKILL");
      });
      p.stderr.on("data", (b) => {
        stderr += b.toString();
        if (stderr.length > 100_000) p.kill("SIGKILL");
      });
      p.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.once("close", (code) => {
        clearTimeout(timer);
        if (timedOut) reject(Error("KUBECTL_TIMEOUT"));
        else resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
}
function args(t: JobTarget) {
  if (
    !t.context ||
    t.context.startsWith("-") ||
    /[\s\x00-\x1f]/.test(t.context) ||
    !namePattern.test(t.namespace) ||
    !namePattern.test(t.job)
  )
    throw Error("INVALID_TARGET");
  return ["--context", t.context, "--namespace", t.namespace];
}
export async function startJob(
  t: JobTarget,
  cronJob: string,
  run: Runner,
  timeoutMs = 10000,
) {
  if (!namePattern.test(cronJob)) throw Error("INVALID_TARGET");
  const r = await run(
    [...args(t), "create", "job", t.job, `--from=cronjob/${cronJob}`],
    timeoutMs,
  );
  if (r.code !== 0) throw Error("JOB_START_FAILED");
}
export async function waitJob(
  t: JobTarget,
  run: Runner,
  timeoutMs: number,
  pollMs = 250,
) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await run(
      [...args(t), "get", "job", t.job, "-o", "json"],
      Math.max(1, Math.min(5000, end - Date.now())),
    );
    if (r.code !== 0) throw Error("JOB_STATUS_FAILED");
    const j = JSON.parse(r.stdout);
    const conditions = j.status?.conditions || [];
    if (conditions.some((c: any) => c.type === "Failed" && c.status === "True"))
      return "failed";
    if (
      conditions.some((c: any) => c.type === "Complete" && c.status === "True")
    )
      return "complete";
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, Math.max(0, end - Date.now()))),
    );
  }
  return "timeout";
}
export async function stopJob(t: JobTarget, run: Runner, timeoutMs: number) {
  const prefix = args(t);
  const end = Date.now() + timeoutMs;
  const r = await run(
    [
      ...prefix,
      "delete",
      "job",
      t.job,
      "--cascade=foreground",
      "--wait=true",
      `--timeout=${Math.max(1, Math.floor(timeoutMs / 1000))}s`,
    ],
    timeoutMs,
  );
  if (r.code !== 0) throw Error("JOB_STOP_UNCONFIRMED");
  const check = await run(
    [...prefix, "get", "job", t.job, "--ignore-not-found", "-o", "name"],
    Math.max(1, end - Date.now()),
  );
  if (check.code !== 0 || check.stdout.trim())
    throw Error("JOB_STOP_UNCONFIRMED");
}
