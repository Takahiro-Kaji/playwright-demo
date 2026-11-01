import { acquireTestLock, releaseTestLock } from "../database/test-lock.ts";
import type { Pool } from "mysql2/promise";
import { Environment } from "./lifecycle.ts";
import { until } from "../support/polling.ts";
import { assertCondition, errorCodes } from "./state.ts";

/** 記録済みの実行リソースのみ削除する。復旧が未完了なら名前空間を残す。 */
export async function cleanup(
  env: Environment,
  options: { stopTimeoutMs?: number } = {},
) {
  const { j, cluster } = env;
  await cluster.identity();
  if (!(await cluster.get("Namespace", j.namespace))) {
    assertCondition(
      !j.dbCreated && !j.userCreated && !j.dbIntent && !j.userIntent,
      "NAMESPACE_MISSING_DB_REQUIRES_RECOVERY",
    );
    j.phase = "cleaned";
    j.blocked = false;
    env.save();
    return;
  }
  await cluster.verify("Namespace", j.namespace);
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<void>, scope?: string) => {
    try {
      await fn();
    } catch (e) {
      errors.push(scope ? new AggregateError([e], scope) : e);
    }
  };
  // 把握しているすべての書き込み処理が停止するまで、DBの変更を許可しない。
  const stops = {
    app: "unconfirmed" as "confirmed" | "unconfirmed",
    jobs: "unconfirmed" as "confirmed" | "unconfirmed",
    reasons: [] as string[],
  };
  j.cleanupStops = stops;
  j.blocked = true;
  j.phase = "cleaning";
  env.save();
  await attempt(async () => {
    await env.batches.stopAll();
    const jobs = JSON.parse(await cluster.k(["get", "jobs", "-o", "json"]));
    assertCondition(jobs.items.length === 0, "UNRECORDED_OR_RUNNING_JOB");
    const cron = await cluster.get("CronJob", "sales-batch");
    if (cron) {
      cluster.owned(cron, "CronJob", "sales-batch");
      assertCondition(cron.spec.suspend === true, "CRON_WRITER_NOT_SUSPENDED");
    }
    stops.jobs = "confirmed";
  }, "JOB_STOP_UNCONFIRMED");
  await attempt(async () => {
    const app = await cluster.get("Deployment", "sales-app");
    if (app) {
      const dep = cluster.owned(app, "Deployment", "sales-app");
      dep.spec.replicas = 0;
      delete dep.metadata.managedFields;
      delete dep.status;
      await cluster.k(["replace", "-f", "-"], dep);
    }
    // Deploymentがすでに消えている場合もPodを確認する。
    await until(
      async () =>
        JSON.parse(
          await cluster.k(["get", "pods", "-l", "app=sales-app", "-o", "json"]),
        ).items.length === 0,
      options.stopTimeoutMs ?? 120000,
      "WRITER_STOP_UNCONFIRMED",
    );
    stops.app = "confirmed";
  }, "APP_STOP_UNCONFIRMED");
  if (stops.app !== "confirmed" || stops.jobs !== "confirmed") {
    stops.reasons = errors.flatMap(errorCodes);
    j.blocked = true;
    j.phase = "recovery-required";
    j.lastErrors = [
      ...(j.lastErrors || []),
      "WRITERS_STOP_UNCONFIRMED",
      ...stops.reasons,
    ];
    env.save();
    throw new AggregateError(errors, "WRITERS_STOP_UNCONFIRMED");
  }
  env.save();
  let db: Pool | undefined;
  if (j.dbOwned && (await cluster.get("Deployment", "sales-upstream")))
    await attempt(async () => {
      const dep = await cluster.verify("Deployment", "sales-upstream");
      dep.spec.replicas = 1;
      delete dep.metadata.managedFields;
      delete dep.status;
      await cluster.k(["replace", "-f", "-"], dep);
      await env.workloads.rollout("sales-upstream");
      db = await env.database.pool();
      const lock = await acquireTestLock(db);
      try {
        await env.restore(db);
      } finally {
        await releaseTestLock(lock);
      }
    });
  if (db)
    await attempt(async () => {
      await db!.end();
    });
  if (await cluster.get("Deployment", "sales-upstream"))
    await attempt(async () => {
      const dep = await cluster.verify("Deployment", "sales-upstream");
      dep.spec.replicas = 0;
      delete dep.metadata.managedFields;
      delete dep.status;
      await cluster.k(["replace", "-f", "-"], dep);
      await until(
        async () =>
          JSON.parse(
            await cluster.k([
              "get",
              "pods",
              "-l",
              "app=sales-upstream",
              "-o",
              "json",
            ]),
          ).items.length === 0,
        120000,
        "UPSTREAM_STOP_UNCONFIRMED",
      );
    });
  // 名前空間の削除前に、コントローラーが所有するALB・ターゲットグループを削除する必要がある。
  if (await cluster.get("Ingress", "sales-sso"))
    await attempt(async () => {
      await env.cluster.deleteOwned("Ingress", "sales-sso", 300000);
    });
  await attempt(async () => {
    await until(
      async () => {
        const stack = `${j.namespace}/sales-sso`;
        for (const [operation, key] of [
          ["describe-load-balancers", "LoadBalancers"],
          ["describe-target-groups", "TargetGroups"],
        ]) {
          const objects = (await cluster.aws("elbv2", operation))[key];
          for (const object of objects) {
            const arn = object.LoadBalancerArn || object.TargetGroupArn;
            const tags =
              (
                await cluster.aws(
                  "elbv2",
                  "describe-tags",
                  "--resource-arns",
                  arn,
                )
              ).TagDescriptions[0]?.Tags || [];
            if (
              tags.some(
                (t: any) =>
                  t.Key === "ingress.k8s.aws/stack" && t.Value === stack,
              )
            )
              return false;
          }
        }
        return true;
      },
      300000,
      "ALB_OR_TARGETGROUP_REMAINS",
      2000,
    );
  });
  if (!errors.length)
    await attempt(async () => {
      await auditNamespace(env);
    });
  if (
    !errors.length &&
    (j.dbCreated || j.userCreated || j.dbIntent || j.userIntent)
  )
    await attempt(async () => {
      await env.database.dropSchema();
    });
  if (!errors.length)
    await attempt(async () => {
      await auditNamespace(env);
      await env.cluster.deleteOwned("Namespace", j.namespace, 180000);
    });
  if (errors.length) {
    j.blocked = true;
    j.phase = "recovery-required";
    j.lastErrors = [...(j.lastErrors || []), ...errors.flatMap(errorCodes)];
    env.save();
    throw new AggregateError(errors, "CLEANUP_FAILED");
  }
  j.phase = "cleaned";
  j.blocked = false;
  env.save();
}

export async function auditNamespace(env: Environment) {
  const { cluster, j } = env;
  // 無関係なオブジェクトが追加されていたら名前空間の削除を拒否する。
  // 既定のオブジェクトと、記録済みUIDを親に持つ配下のリソースのみ例外とする。
  const types = (
    await cluster.k([
      "api-resources",
      "--namespaced=true",
      "--verbs=list,delete",
      "-o",
      "name",
    ])
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const allowed = new Set(j.resources.map((r) => r.uid).filter(Boolean));
  const pending: any[] = [];
  for (const type of types) {
    if (type === "events" || type === "events.events.k8s.io") continue;
    const items =
      JSON.parse(await cluster.k(["get", type, "-o", "json"])).items || [];
    for (const item of items) {
      if (
        (type === "serviceaccounts" && item.metadata.name === "default") ||
        (type === "configmaps" && item.metadata.name === "kube-root-ca.crt")
      )
        continue;
      if (
        type === "endpoints" &&
        ["sales-app", "sales-upstream"].includes(item.metadata.name)
      ) {
        await cluster.verify("Service", item.metadata.name);
        continue;
      }
      if (!allowed.has(item.metadata.uid)) pending.push(item);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--)
      if (
        pending[i].metadata.ownerReferences?.some((o: any) =>
          allowed.has(o.uid),
        )
      ) {
        allowed.add(pending[i].metadata.uid);
        pending.splice(i, 1);
        changed = true;
      }
  }
  assertCondition(pending.length === 0, "UNOWNED_NAMESPACE_RESOURCES");
}
