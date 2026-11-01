import {
  terminationEvidence,
  classifyBatch,
  type BatchResult,
} from "./batch-result.ts";
import { readFileSync } from "node:fs";
import type { Pool } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { resolve4, resolveCname } from "node:dns/promises";
import {
  Cluster,
  assertCondition,
  saveJournal,
  type Journal,
  type Command,
} from "./environment.ts";
import { manifests } from "./resources.ts";
import { createPodPool } from "./mysql-tunnel.ts";
import { snapshotMysql, compareMysql } from "./db.ts";
import { salesFixture } from "./fixture.ts";

export const pause = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
export async function until(
  fn: () => Promise<boolean>,
  ms: number,
  code: string,
  poll = 500,
) {
  const deadline = performance.now() + ms;
  do {
    if (await fn()) return;
    if (performance.now() >= deadline) break;
    await pause(Math.min(poll, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw Error(code);
}
export function expectedFixture(name: string) {
  const f = salesFixture(name);
  return {
    products: f.products.map((p, i) => ({
      ...p,
      version: name === "bulk2" ? 2 : name === "f2" && i === 0 ? 2 : 1,
    })),
    deleted: [],
    catalogVersion: f.catalogVersion,
    orders: [],
  };
}
export function checkEnv(container: any, j: Journal) {
  assertCondition(
    !container?.envFrom &&
      !container?.args &&
      (!container?.command ||
        JSON.stringify(container.command) ===
          JSON.stringify(["node", "aws/sales/runtime.ts", "batch"]) ||
        JSON.stringify(container.command) ===
          JSON.stringify(["node", "aws/sales/runtime.ts", "app"])),
    "WORKLOAD_COMMAND_MISMATCH",
  );
  const env = new Map((container?.env || []).map((e: any) => [e.name, e]));
  assertCondition(
    (env.get("DB_HOST") as any)?.value === j.config.dbHost &&
      (env.get("DB_NAME") as any)?.value === j.database,
    "WORKLOAD_DB_MISMATCH",
  );
  for (const key of ["USER", "PASSWORD"]) {
    const ref = (env.get(`DB_${key}`) as any)?.valueFrom?.secretKeyRef;
    assertCondition(
      ref?.name === "sales-db" && ref?.key === key.toLowerCase(),
      "WORKLOAD_SECRET_MISMATCH",
    );
  }
  assertCondition(
    (env.get("UPSTREAM_URL") as any)?.value === "http://sales-upstream:8081/",
    "WORKLOAD_UPSTREAM_MISMATCH",
  );
  assertCondition(container.image === j.config.image, "WORKLOAD_IMAGE_MISMATCH");
  assertCondition(
    !env.has("NODE_OPTIONS") &&
      (env.get("DB_CA_FILE") as any)?.value === "/certs/global-bundle.pem" &&
      container.volumeMounts?.some(
        (m: any) =>
          m.name === "rds-ca" &&
          m.mountPath === "/certs" &&
          m.readOnly === true,
      ),
    "WORKLOAD_TLS_MISMATCH",
  );
}
export class Environment {
  readonly cluster: Cluster;
  readonly file: string;
  readonly j: Journal;
  constructor(file: string, j: Journal, run?: Command) {
    this.file = file;
    this.j = j;
    this.cluster = new Cluster(j, run);
  }
  save() {
    saveJournal(this.file, this.j);
  }
  async bridge() {
    const p = await this.cluster.verify("Pod", "sales-db-bridge");
    assertCondition(
      JSON.stringify(p.spec.containers?.[0]?.command) ===
        JSON.stringify(["node", "-e", "setInterval(()=>{},60000)"]) &&
        !p.spec.containers?.[0]?.args &&
        !p.spec.containers?.[0]?.envFrom,
      "BRIDGE_COMMAND_MISMATCH",
    );
    assertCondition(
      p.spec.containers?.[0]?.image === this.j.config.image &&
        p.spec.containers[0].env?.find((e: any) => e.name === "DB_HOST")
          ?.value === this.j.config.dbHost,
      "BRIDGE_CONFIG_MISMATCH",
    );
    assertCondition(
      p.status?.phase === "Running" &&
        p.status?.conditions?.some(
          (c: any) => c.type === "Ready" && c.status === "True",
        ),
      "BRIDGE_NOT_READY",
    );
    return p;
  }
  async pool(admin = false): Promise<Pool> {
    await this.bridge();
    const dbUser = admin ? process.env.AWS_SALES_ADMIN_USER : this.j.user,
      dbPassword = admin
        ? process.env.AWS_SALES_ADMIN_PASSWORD
        : this.j.password;
    assertCondition(dbUser && dbPassword, "ADMIN_CREDENTIALS_REQUIRED");
    return createPodPool(
      {
        runId: this.j.runId,
        context: this.j.config.context,
        pod: "sales-db-bridge",
        dbHost: this.j.config.dbHost,
        dbUser,
        dbPassword,
        caFile: this.j.config.caFile,
      },
      this.j.namespace,
      "bridge",
      admin ? undefined : this.j.database,
    );
  }
  async dbOwner(pool: Pool) {
    const [rows] = await pool.query<any[]>(
      "SELECT run_id,owner_token FROM aws_test_owner WHERE id=1",
    );
    assertCondition(
      rows.length === 1 &&
        rows[0].run_id === this.j.runId &&
        rows[0].owner_token === this.j.owner,
      "DB_OWNERSHIP_MISMATCH",
    );
  }
  async prepare() {
    assertCondition(this.j.phase === "new", "PREPARE_ALREADY_STARTED");
    await this.cluster.identity();
    const m = manifests(this.j);
    this.j.phase = "preparing";
    this.save();
    await this.cluster.create(this.file, m.namespace);
    await this.cluster.create(this.file, m.bridge);
    await until(
      async () =>
        (
          await this.cluster.verify("Pod", "sales-db-bridge")
        ).status?.conditions?.some(
          (c: any) => c.type === "Ready" && c.status === "True",
        ),
      120000,
      "BRIDGE_START_TIMEOUT",
    );
    const admin = await this.pool(true);
    try {
      // 既存のDBやユーザーを流用しないよう、IF NOT EXISTSは使わない。
      this.j.dbIntent = true;
      this.save();
      await admin.query(
        `CREATE DATABASE \`${this.j.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
      );
      this.j.dbCreated = true;
      this.save();
      await admin.query(
        `CREATE TABLE \`${this.j.database}\`.aws_test_owner (id INT PRIMARY KEY,run_id CHAR(32) NOT NULL,owner_token CHAR(48) NOT NULL)`,
      );
      await admin.execute(
        `INSERT INTO \`${this.j.database}\`.aws_test_owner VALUES (1,?,?)`,
        [this.j.runId, this.j.owner],
      );
      this.j.dbOwned = true;
      this.save();
      // 初期化にはスキーマを明示した単一の接続を使用する。
      const c = await admin.getConnection();
      try {
        await c.query(`USE \`${this.j.database}\``);
        for (const sql of readFileSync("aws/sales/schema.sql", "utf8")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean))
          await c.query(sql);
      } finally {
        c.release();
      }
      this.j.userIntent = true;
      this.save();
      await admin.query(
        `CREATE USER '${this.j.user}'@'%' IDENTIFIED BY '${this.j.password}' REQUIRE SSL ATTRIBUTE '{"salesOwner":"${this.j.owner}"}'`,
      );
      this.j.userCreated = true;
      this.save();
      for (const table of [
        "products",
        "inventory",
        "orders",
        "sync_state",
        "sales_lock",
      ])
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE,DELETE ON \`${this.j.database}\`.${table} TO '${this.j.user}'@'%'`,
        );
      await admin.query(
        `GRANT SELECT ON \`${this.j.database}\`.aws_test_owner TO '${this.j.user}'@'%'`,
      );
    } finally {
      await admin.end();
    }
    for (const object of [
      m.secret,
      m.mockSecret,
      m.ca,
      m.catalog,
      m.upstream,
      m.upstreamService,
      m.app,
      m.service,
      m.cron,
      m.ingress,
    ])
      await this.cluster.create(this.file, object);
    await this.rollout("sales-upstream");
    await this.rollout("sales-app");
    const db = await this.pool();
    try {
      await this.dbOwner(db);
      await this.reset(db);
      await this.catalogMatches("f1");
      assertCondition(
        (await this.batch()).outcome === "complete",
        "INITIAL_BATCH_FAILED",
      );
      assertCondition(
        (await compareMysql(db, expectedFixture("f1"))).length === 0,
        "INITIAL_DB_MISMATCH",
      );
    } finally {
      await db.end();
    }
    this.j.phase = "prepared";
    this.save();
  }
  async rollout(name: string) {
    await this.cluster.verify("Deployment", name);
    await this.cluster.k(
      ["rollout", "status", `deployment/${name}`, "--timeout=120s"],
      undefined,
      125000,
    );
    await this.pod(name);
  }
  async pod(name: "sales-app" | "sales-upstream" | string) {
    const dep = await this.cluster.verify("Deployment", name);
    assertCondition(
      dep.status?.observedGeneration === dep.metadata.generation &&
        dep.status?.readyReplicas === 1 &&
        dep.spec.replicas === 1,
      "DEPLOYMENT_NOT_READY",
    );
    const list = JSON.parse(
      await this.cluster.k(["get", "pods", "-l", `app=${name}`, "-o", "json"]),
    );
    const pods = list.items.filter((p: any) => !p.metadata.deletionTimestamp);
    assertCondition(pods.length === 1, "POD_COUNT_MISMATCH");
    const p = pods[0];
    assertCondition(
      p.metadata.labels?.["sales-run"] === this.j.runId &&
        p.metadata.labels?.["sales-owner"] === this.j.owner &&
        p.status?.conditions?.some(
          (x: any) => x.type === "Ready" && x.status === "True",
        ),
      "POD_NOT_OWNED_OR_READY",
    );
    const owner = p.metadata.ownerReferences?.find(
      (x: any) => x.controller === true,
    );
    assertCondition(owner?.kind === "ReplicaSet", "POD_OWNER_INVALID");
    const rs = await this.cluster.get("ReplicaSet", owner.name);
    assertCondition(
      rs?.metadata.uid === owner.uid &&
        rs.metadata.ownerReferences?.some(
          (x: any) =>
            x.uid === dep.metadata.uid &&
            x.kind === "Deployment" &&
            x.controller,
        ),
      "REPLICASET_OWNER_MISMATCH",
    );
    if (name === "sales-app")
      checkEnv(
        p.spec.containers?.find((c: any) => c.name === "app"),
        this.j,
      );
    if (name === "sales-upstream") {
      const c = p.spec.containers?.find((c: any) => c.name === "upstream");
      assertCondition(
        c?.image === this.j.config.image &&
          !c.envFrom &&
          ["upstream", "mock"].includes(c.command?.[2]) &&
          c.command[0] === "node" &&
          c.command[1] === "aws/sales/runtime.ts",
        "UPSTREAM_WORKLOAD_MISMATCH",
      );
      assertCondition(
        c.env?.find((e: any) => e.name === "MOCK_TOKEN")?.valueFrom
          ?.secretKeyRef?.name === "sales-mock",
        "MOCK_SECRET_REFERENCE_MISMATCH",
      );
    }
    return p;
  }
  async verifyTarget(dns = true) {
    const eks = await this.cluster.identity();
    await this.cluster.verify("Namespace", this.j.namespace);
    await this.bridge();
    const p = await this.pod("sales-app"),
      service = await this.cluster.verify("Service", "sales-app");
    assertCondition(
      service.spec.selector?.["sales-owner"] === this.j.owner &&
        service.spec.selector?.app === "sales-app" &&
        service.spec.ports?.length === 1 &&
        service.spec.ports[0].port === 8080,
      "SERVICE_MISMATCH",
    );
    assertCondition(
      p.spec.volumes?.some(
        (v: any) => v.name === "rds-ca" && v.configMap?.name === "rds-ca",
      ),
      "POD_CA_VOLUME_MISMATCH",
    );
    const eps = await this.cluster.get("Endpoints", "sales-app");
    const ips = (eps?.subsets || []).flatMap((s: any) => s.addresses || []);
    assertCondition(
      ips.length === 1 &&
        ips[0].ip === p.status.podIP &&
        ips[0].targetRef?.uid === p.metadata.uid,
      "SERVICE_ENDPOINT_MISMATCH",
    );
    const ing = await this.cluster.verify("Ingress", "sales-sso"),
      rule = ing.spec?.rules?.[0];
    assertCondition(
      ing.spec.rules.length === 1 &&
        rule.host === new URL(this.j.config.url).hostname &&
        rule.http.paths.length === 1 &&
        rule.http.paths[0].backend.service.name === "sales-app" &&
        rule.http.paths[0].backend.service.port.number === 8080,
      "INGRESS_TARGET_MISMATCH",
    );
    const a = ing.metadata.annotations;
    assertCondition(
      a["alb.ingress.kubernetes.io/certificate-arn"] ===
        this.j.config.certificateArn &&
        a["alb.ingress.kubernetes.io/target-type"] === "ip" &&
        a["alb.ingress.kubernetes.io/inbound-cidrs"] ===
          this.j.config.operatorCidr,
      "INGRESS_SETTINGS_MISMATCH",
    );
    assertCondition(
      a["alb.ingress.kubernetes.io/auth-type"] === "cognito" &&
        a["alb.ingress.kubernetes.io/auth-on-unauthenticated-request"] ===
          "authenticate",
      "INGRESS_AUTH_MISMATCH",
    );
    const auth = JSON.parse(a["alb.ingress.kubernetes.io/auth-idp-cognito"]);
    assertCondition(
      auth.userPoolARN === this.j.config.userPoolArn &&
        auth.userPoolClientID === this.j.config.userPoolClientId &&
        auth.userPoolDomain === this.j.config.userPoolDomain,
      "INGRESS_COGNITO_MISMATCH",
    );
    const host = ing.status?.loadBalancer?.ingress?.[0]?.hostname;
    assertCondition(
      typeof host === "string" && host.endsWith(".elb.amazonaws.com"),
      "ALB_NOT_READY",
    );
    const { LoadBalancers: lbs } = await this.cluster.aws(
      "elbv2",
      "describe-load-balancers",
    );
    const lb = lbs.find((l: any) => l.DNSName === host);
    assertCondition(
      lb &&
        lb.VpcId === eks.resourcesVpcConfig.vpcId &&
        lb.Scheme === "internet-facing" &&
        lb.State.Code === "active",
      "ALB_IDENTITY_MISMATCH",
    );
    const { Listeners: listeners } = await this.cluster.aws(
      "elbv2",
      "describe-listeners",
      "--load-balancer-arn",
      lb.LoadBalancerArn,
    );
    const listener = listeners.find(
      (l: any) =>
        l.Port === 443 &&
        l.Protocol === "HTTPS" &&
        l.Certificates?.some(
          (c: any) => c.CertificateArn === this.j.config.certificateArn,
        ),
    );
    assertCondition(listener, "ALB_LISTENER_MISMATCH");
    const { Rules: rules } = await this.cluster.aws(
      "elbv2",
      "describe-rules",
      "--listener-arn",
      listener.ListenerArn,
    );
    const matching = rules.filter((r: any) =>
      r.Conditions?.some(
        (v: any) =>
          v.Field === "host-header" &&
          (v.HostHeaderConfig?.Values || v.Values)?.includes(rule.host),
      ),
    );
    assertCondition(matching.length === 1, "ALB_RULE_MISMATCH");
    const actions = matching[0].Actions;
    const authentication = actions.find(
      (x: any) => x.Type === "authenticate-cognito",
    )?.AuthenticateCognitoConfig;
    assertCondition(
      authentication?.UserPoolArn === this.j.config.userPoolArn &&
        authentication?.UserPoolClientId === this.j.config.userPoolClientId &&
        authentication?.UserPoolDomain === this.j.config.userPoolDomain &&
        authentication?.OnUnauthenticatedRequest === "authenticate",
      "ALB_AUTH_MISMATCH",
    );
    const forward = actions.find((x: any) => x.Type === "forward");
    const groups = forward?.ForwardConfig?.TargetGroups || [
      { TargetGroupArn: forward?.TargetGroupArn },
    ];
    assertCondition(
      groups.length === 1 && groups[0].TargetGroupArn,
      "ALB_FORWARD_MISMATCH",
    );
    const { TargetHealthDescriptions: targets } = await this.cluster.aws(
      "elbv2",
      "describe-target-health",
      "--target-group-arn",
      groups[0].TargetGroupArn,
    );
    assertCondition(
      targets.length === 1 &&
        targets[0].Target.Id === p.status.podIP &&
        targets[0].Target.Port === 8080 &&
        targets[0].TargetHealth.State === "healthy",
      "ALB_TARGET_MISMATCH",
    );
    if (dns) {
      let matches = false;
      for (let n = 0; n < 3 && !matches; n++) {
        const [ui, alb] = await Promise.all([
          resolve4(rule.host),
          resolve4(host),
        ]);
        matches = ui.length > 0 && ui.every((ip) => alb.includes(ip));
        if (!matches) {
          try {
            matches = (await resolveCname(rule.host)).some(
              (x) => x.replace(/\.$/, "") === host,
            );
          } catch {}
        }
      }
      assertCondition(matches, "DNS_ALB_MISMATCH");
    }
    await this.verifyDatabaseAndBatch();
  }
  async verifyBatchTarget() {
    await this.cluster.identity();
    await this.cluster.verify("Namespace", this.j.namespace);
    await this.bridge();
    await this.verifyDatabaseAndBatch();
  }
  async verifyDatabaseAndBatch() {
    const mock = await this.cluster.verify("Secret", "sales-mock");
    assertCondition(
      Buffer.from(mock.data.token, "base64").toString() === this.j.mockToken,
      "MOCK_SECRET_MISMATCH",
    );
    const ca = await this.cluster.verify("ConfigMap", "rds-ca");
    assertCondition(
      ca.data?.["global-bundle.pem"] ===
        readFileSync(this.j.config.caFile, "utf8"),
      "WORKLOAD_CA_MISMATCH",
    );
    const secret = await this.cluster.verify("Secret", "sales-db");
    assertCondition(
      Buffer.from(secret.data.user, "base64").toString() === this.j.user &&
        Buffer.from(secret.data.password, "base64").toString() ===
          this.j.password,
      "DB_SECRET_MISMATCH",
    );
    const cron = await this.cluster.verify("CronJob", "sales-batch");
    assertCondition(
      cron.spec.suspend === true &&
        cron.spec.jobTemplate.spec.activeDeadlineSeconds === 180 &&
        cron.spec.jobTemplate.spec.backoffLimit === 0,
      "BATCH_TEMPLATE_MISMATCH",
    );
    checkEnv(cron.spec.jobTemplate.spec.template.spec.containers[0], this.j);
    const db = await this.pool();
    try {
      await this.dbOwner(db);
    } finally {
      await db.end();
    }
  }
  async execUpstream(script: string) {
    const p = await this.pod("sales-upstream");
    return this.cluster.k([
      "exec",
      p.metadata.name,
      "-c",
      "upstream",
      "--",
      "node",
      "-e",
      script,
    ]);
  }
  async catalogMatches(name: string, status = 200) {
    const want = createHash("sha256")
      .update(status === 200 ? JSON.stringify(salesFixture(name)) : "")
      .digest("hex");
    const raw = await this.execUpstream(
      `fetch('http://127.0.0.1:8081/catalog',{signal:AbortSignal.timeout(5000)}).then(async r=>console.log(JSON.stringify({status:r.status,hash:require('node:crypto').createHash('sha256').update(await r.text()).digest('hex')}))).catch(()=>process.exit(1))`,
    );
    const result = JSON.parse(raw);
    assertCondition(
      result.status === status && result.hash === want,
      "UPSTREAM_RESPONSE_MISMATCH",
    );
  }
  async catalog(name: string, mode: "upstream" | "mock" = "upstream") {
    const cm = await this.cluster.verify("ConfigMap", "sales-catalog");
    cm.data = { "catalog.json": JSON.stringify(salesFixture(name)) };
    delete cm.metadata.managedFields;
    await this.cluster.k(["replace", "-f", "-"], cm);
    const dep = await this.cluster.verify("Deployment", "sales-upstream");
    dep.spec.template.spec.containers[0].command = [
      "node",
      "aws/sales/runtime.ts",
      mode,
    ];
    dep.spec.template.metadata.annotations = {
      ...(dep.spec.template.metadata.annotations || {}),
      "sales-catalog-generation": randomBytes(8).toString("hex"),
    };
    delete dep.metadata.managedFields;
    delete dep.status;
    await this.cluster.k(["replace", "-f", "-"], dep);
    await this.rollout("sales-upstream");
    await this.catalogMatches(name);
    const pod = await this.pod("sales-upstream");
    assertCondition(pod.spec.containers[0].command[2] === mode, "UPSTREAM_MODE_MISMATCH");
  }
  async mockStatus(value?: number) {
    assertCondition(
      value === undefined || value === 200 || value === 503,
      "MOCK_STATUS_INVALID",
    );
    const method = value === undefined ? "GET" : "PUT";
    const raw = await this.execUpstream(
      `fetch('http://127.0.0.1:8081/admin/status',{method:'${method}',headers:{authorization:'Bearer '+process.env.MOCK_TOKEN,'content-type':'application/json'},${value === undefined ? "" : `body:JSON.stringify({status:${value}}),`}signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)process.exit(2);console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))`,
    );
    const { status } = JSON.parse(raw);
    assertCondition(
      [200, 503].includes(status) && (value === undefined || status === value),
      "MOCK_CONTROL_MISMATCH",
    );
    return status as number;
  }
  async reset(pool: Pool) {
    await this.dbOwner(pool);
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.query<any[]>(
        "SELECT id FROM sales_lock WHERE id=1 FOR UPDATE",
      );
      assertCondition(rows.length === 1, "SCHEMA_LOCK_MISSING");
      for (const table of ["orders", "inventory", "products", "sync_state"])
        await c.query(`DELETE FROM ${table}`);
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
    const s = await snapshotMysql(pool);
    assertCondition(
      Object.values(s).every((v: any) => v.length === 0),
      "EMPTY_DB_UNCONFIRMED",
    );
  }
  async deleteOwned(kind: string, name: string, timeout = 120000) {
    const object = await this.cluster.get(kind, name);
    if (!object) return;
    this.cluster.owned(object, kind, name);
    const paths: Record<string, string> = {
      Job: "apis/batch/v1",
      Ingress: "apis/networking.k8s.io/v1",
      Namespace: "api/v1",
    };
    assertCondition(paths[kind], "DELETE_KIND_INVALID");
    const plural: Record<string, string> = {
      Job: "jobs",
      Ingress: "ingresses",
      Namespace: "namespaces",
    };
    const path =
      kind === "Namespace"
        ? `/${paths[kind]}/namespaces/${name}`
        : `/${paths[kind]}/namespaces/${this.j.namespace}/${plural[kind]}/${name}`;
    await this.cluster.k(["delete", `--raw=${path}`, "-f", "-"], {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: {
        uid: object.metadata.uid,
        resourceVersion: object.metadata.resourceVersion,
      },
      propagationPolicy: "Foreground",
    });
    await until(
      async () => !(await this.cluster.get(kind, name)),
      timeout,
      "RESOURCE_STOP_UNCONFIRMED",
    );
  }
  async batch(waitMs = 190000): Promise<BatchResult> {
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
    this.save();
    let afterError: unknown;
    try {
      await this.deleteOwned("Job", name);
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
      this.save();
    }
    this.save();
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
  async stopJobs() {
    const failures: unknown[] = [];
    for (const r of this.j.resources.filter((r) => r.kind === "Job"))
      try {
        await this.deleteOwned("Job", r.name);
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
  async restore(pool: Pool) {
    const errors: unknown[] = [];
    let stopped = false;
    try {
      await this.stopJobs();
      stopped = true;
    } catch (e) {
      errors.push(e);
    }
    try {
      await this.catalog("f1", "upstream");
    } catch (e) {
      errors.push(e);
    }
    // バッチの書き込み処理が動作している可能性がある間は、データを削除しない。
    if (stopped)
      try {
        await this.reset(pool);
      } catch (e) {
        errors.push(e);
      }
    if (!errors.length)
      try {
        assertCondition(
          (await this.batch()).outcome === "complete",
          "RESTORE_BATCH_FAILED",
        );
        assertCondition(
          (await compareMysql(pool, expectedFixture("f1"))).length === 0,
          "RESTORE_DB_MISMATCH",
        );
        await this.catalogMatches("f1");
      } catch (e) {
        errors.push(e);
      }
    if (errors.length) {
      this.j.blocked = true;
      this.save();
      throw new AggregateError(errors, "RESTORE_FAILED");
    }
  }
}
