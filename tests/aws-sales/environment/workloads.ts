import type { Cluster } from "./cluster.ts";
import { assertCondition, type Journal } from "./state.ts";

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
  assertCondition(
    container.image === j.config.image,
    "WORKLOAD_IMAGE_MISMATCH",
  );
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
/** Deployment/Podの準備完了と実際のコンテナ設定を照合する。 */
export class Workloads {
  readonly j: Journal;
  readonly cluster: Cluster;
  constructor(j: Journal, cluster: Cluster) {
    this.j = j;
    this.cluster = cluster;
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
}
