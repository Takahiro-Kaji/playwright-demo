import { acquireTestLock, releaseTestLock } from "./db.ts";
import type { Pool } from "mysql2/promise";
import { Environment, until } from "./lifecycle.ts";
import { requireThat as check } from "./environment.ts";

/** Delete only recorded run resources, preserving the namespace if recovery is incomplete. */
export async function cleanup(env: Environment) {
  const { j, cluster } = env;
  await cluster.identity();
  if (!(await cluster.get("Namespace", j.namespace))) {
    check(
      !j.dbCreated && !j.userCreated && !j.dbIntent && !j.userIntent,
      "NAMESPACE_MISSING_DB_REQUIRES_RECOVERY",
    );
    j.phase = "cleaned";
    env.save();
    return;
  }
  await cluster.verify("Namespace", j.namespace);
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(e);
    }
  };
  // Recover all jobs, including response-loss cases whose UIDs were reconciled.
  for (const r of j.resources.filter((r) => r.kind === "Job"))
    await attempt(async () => {
      await env.deleteOwned("Job", r.name);
      const pods = JSON.parse(
        await cluster.k([
          "get",
          "pods",
          "-l",
          `job-name=${r.name}`,
          "-o",
          "json",
        ]),
      );
      check(pods.items.length === 0, "JOB_PODS_STOP_UNCONFIRMED");
    });
  // Disable HTTP writers before database restoration. This also makes cleanup
  // retryable after a previous invocation already scaled the app down.
  if (await cluster.get("Deployment", "sales-app"))
    await attempt(async () => {
      const dep = await cluster.verify("Deployment", "sales-app");
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
              "app=sales-app",
              "-o",
              "json",
            ]),
          ).items.length === 0,
        120000,
        "WRITER_STOP_UNCONFIRMED",
      );
    });
  let db: Pool | undefined;
  if (j.dbOwned && (await cluster.get("Deployment", "sales-upstream")))
    await attempt(async () => {
      const dep = await cluster.verify("Deployment", "sales-upstream");
      dep.spec.replicas = 1;
      delete dep.metadata.managedFields;
      delete dep.status;
      await cluster.k(["replace", "-f", "-"], dep);
      await env.rollout("sales-upstream");
      db = await env.pool();
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
  // Controller must remove the owned ALB/TGs before the namespace can disappear.
  if (await cluster.get("Ingress", "sales-sso"))
    await attempt(async () => {
      await env.deleteOwned("Ingress", "sales-sso", 300000);
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
      const admin = await env.pool(true);
      try {
        if (j.dbCreated || j.dbIntent) {
          const [schemas] = await admin.execute<any[]>(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
            [j.database],
          );
          if (!schemas.length) {
            j.dbCreated = false;
            j.dbOwned = false;
            j.dbIntent = false;
            env.save();
          }
        }
        if (j.dbCreated || j.dbIntent) {
          check(j.dbOwned, "DB_OWNER_MARKER_MISSING_MANUAL_REVIEW_REQUIRED");
          const [owner] = await admin.query<any[]>(
            `SELECT run_id,owner_token FROM \`${j.database}\`.aws_test_owner WHERE id=1`,
          );
          check(
            owner.length === 1 &&
              owner[0].run_id === j.runId &&
              owner[0].owner_token === j.owner,
            "DB_OWNERSHIP_MISMATCH",
          );
          // Use the restricted user to revoke sessions before dropping the schema.
          // All app and Job pods are already confirmed absent; no ordinary user has this grant.
        }
        if (j.userCreated || j.userIntent) {
          const [users] = await admin.execute<any[]>(
            "SELECT User,Host,JSON_UNQUOTE(JSON_EXTRACT(User_attributes,'$.metadata.salesOwner')) AS owner FROM mysql.user WHERE User=? AND Host='%'",
            [j.user],
          );
          check(
            users.length === 0 ||
              (users.length === 1 && users[0].owner === j.owner),
            "DB_USER_OWNERSHIP_MISMATCH",
          );
          if (users.length) await admin.query(`DROP USER '${j.user}'@'%'`);
          const [remaining] = await admin.execute<any[]>(
            "SELECT User FROM mysql.user WHERE User=? AND Host='%'",
            [j.user],
          );
          check(remaining.length === 0, "DB_USER_DROP_UNCONFIRMED");
          j.userCreated = false;
          j.userIntent = false;
          env.save();
        }
        if (j.dbCreated) {
          await admin.query(`DROP DATABASE \`${j.database}\``);
          const [remaining] = await admin.execute<any[]>(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
            [j.database],
          );
          check(remaining.length === 0, "DB_DROP_UNCONFIRMED");
          j.dbCreated = false;
          j.dbOwned = false;
          j.dbIntent = false;
          env.save();
        }
      } finally {
        await admin.end();
      }
    });
  if (!errors.length)
    await attempt(async () => {
      await auditNamespace(env);
      await env.deleteOwned("Namespace", j.namespace, 180000);
    });
  if (errors.length) {
    j.blocked = true;
    j.phase = "recovery-required";
    env.save();
    throw new AggregateError(errors, "CLEANUP_FAILED");
  }
  j.phase = "cleaned";
  j.blocked = false;
  env.save();
}

export async function auditNamespace(env: Environment) {
  const { cluster, j } = env;
  // Refuse namespace deletion if unrelated objects were introduced. Default
  // objects and descendants of recorded UIDs are the only exceptions.
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
  check(pending.length === 0, "UNOWNED_NAMESPACE_RESOURCES");
}
