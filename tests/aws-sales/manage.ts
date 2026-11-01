import { acquireTestLock, releaseTestLock } from "./db.ts";
import { existsSync, writeFileSync } from "node:fs";
import {
  loadConfig,
  newJournal,
  loadJournal,
  saveJournal,
  exclusive,
  localPath,
  assertCondition,
  unlockStale,
  errorCodes,
  type Journal,
} from "./environment.ts";
import { Environment } from "./lifecycle.ts";
import { cleanup } from "./cleanup.ts";

/** 準備・確認・復旧・削除の操作。テスト検出時には呼び出さない。 */
export async function manage(
  action: string,
  file: string,
  configFile?: string,
  create: (file: string, j: Journal) => Environment = (file, j) =>
    new Environment(file, j),
) {
  localPath(file);
  if (action === "prepare") {
    assertCondition(
      configFile && !existsSync(file),
      "NEW_JOURNAL_AND_CONFIG_REQUIRED",
    );
    const j = newJournal(loadConfig(configFile));
    writeFileSync(localPath(file), JSON.stringify(j), {
      flag: "wx",
      mode: 0o600,
    });
    const unlock = exclusive(file);
    try {
      await create(file, j).prepare();
    } catch (e) {
      j.blocked = true;
      j.phase = "prepare-failed";
      saveJournal(file, j);
      throw e;
    } finally {
      unlock();
    }
    return;
  }
  if (action === "unlock") {
    unlockStale(file);
    return;
  }
  if (action === "summary") {
    const j = loadJournal(file);
    console.log(
      JSON.stringify({
        runId: j.runId,
        phase: j.phase,
        blocked: j.blocked,
        results: j.results.map(
          ({ id, verdict, after, codes, differences }) => ({
            id,
            verdict,
            after,
            codes,
            differences,
          }),
        ),
      }),
    );
    return;
  }
  const unlock = exclusive(file);
  try {
    const j = loadJournal(file),
      env = create(file, j);
    if (action === "describe") {
      await env.cluster.identity();
      await env.cluster.verify("Namespace", j.namespace);
      const ingress = await env.cluster.get("Ingress", "sales-sso");
      if (ingress) env.cluster.owned(ingress, "Ingress", "sales-sso");
      console.log(
        JSON.stringify({
          runId: j.runId,
          namespace: j.namespace,
          database: j.database,
          phase: j.phase,
          albDns: ingress?.status?.loadBalancer?.ingress?.[0]?.hostname || null,
        }),
      );
    } else if (action === "auth") {
      await env.verifyTarget();
      assertCondition(process.stdin.isTTY, "INTERACTIVE_TERMINAL_REQUIRED");
      const { setupAuth } = await import("../../test-support/auth/setup.ts");
      await setupAuth(
        j.config.stateFile,
        j.config.url,
        j.config.url,
        "#refresh",
      );
    } else if (action === "check") await env.verifyTarget();
    else if (action === "check-batch") await env.verifyBatchTarget();
    else if (action === "cleanup") await cleanup(env);
    else if (action === "recover") {
      await env.cluster.identity();
      await env.cluster.verify("Namespace", j.namespace);
      await env.bridge();
      // 基準データを復元する前に、記録済みの全Jobの状態を照合する。
      for (const r of j.resources.filter((r) => r.kind === "Job"))
        await env.deleteOwned("Job", r.name);
      for (const name of ["sales-upstream", "sales-app"]) {
        const dep = await env.cluster.verify("Deployment", name);
        dep.spec.replicas = 1;
        delete dep.metadata.managedFields;
        delete dep.status;
        await env.cluster.k(["replace", "-f", "-"], dep);
        await env.rollout(name);
      }
      const db = await env.pool();
      try {
        const lock = await acquireTestLock(db);
        try {
          await env.restore(db);
        } finally {
          await releaseTestLock(lock);
        }
      } finally {
        await db.end();
      }
      if (await env.cluster.get("Ingress", "sales-sso"))
        await env.verifyTarget();
      j.blocked = false;
      j.phase = (await env.cluster.get("Ingress", "sales-sso"))
        ? "prepared"
        : "restored";
      saveJournal(file, j);
    } else throw Error("ACTION_INVALID");
  } finally {
    unlock();
  }
}
if (import.meta.main)
  manage(process.argv[2], process.argv[3], process.argv[4])
    .then(() => console.log("AWS_SALES_OPERATION_CONFIRMED"))
    .catch((error) => {
      const codes = errorCodes(error);
      try {
        const j = loadJournal(process.argv[3]);
        j.lastErrors = [...new Set([...(j.lastErrors || []), ...codes])];
        saveJournal(process.argv[3], j);
      } catch {}
      console.error("AWS_SALES_OPERATION_FAILED " + codes.join(","));
      process.exitCode = 1;
    });
