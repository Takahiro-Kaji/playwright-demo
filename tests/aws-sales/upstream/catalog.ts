import { createHash, randomBytes } from "node:crypto";
import type { Cluster } from "../environment/cluster.ts";
import type { Workloads } from "../environment/workloads.ts";
import { assertCondition } from "../environment/state.ts";
import { salesFixture } from "./fixtures.ts";

/** 上流データとモック状態を切り替え、実HTTP応答まで確認する。 */
export class UpstreamCatalog {
  readonly cluster: Cluster;
  readonly workloads: Workloads;
  constructor(cluster: Cluster, workloads: Workloads) {
    this.cluster = cluster;
    this.workloads = workloads;
  }
  async execute(script: string) {
    const p = await this.workloads.pod("sales-upstream");
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
  async verifyFixture(name: string, status = 200) {
    const want = createHash("sha256")
      .update(status === 200 ? JSON.stringify(salesFixture(name)) : "")
      .digest("hex");
    const raw = await this.execute(
      `fetch('http://127.0.0.1:8081/catalog',{signal:AbortSignal.timeout(5000)}).then(async r=>console.log(JSON.stringify({status:r.status,hash:require('node:crypto').createHash('sha256').update(await r.text()).digest('hex')}))).catch(()=>process.exit(1))`,
    );
    const result = JSON.parse(raw);
    assertCondition(
      result.status === status && result.hash === want,
      "UPSTREAM_RESPONSE_MISMATCH",
    );
  }
  async useFixture(name: string, mode: "upstream" | "mock" = "upstream") {
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
    await this.workloads.rollout("sales-upstream");
    await this.verifyFixture(name);
    const pod = await this.workloads.pod("sales-upstream");
    assertCondition(
      pod.spec.containers[0].command[2] === mode,
      "UPSTREAM_MODE_MISMATCH",
    );
  }
  async mockStatus(value?: number) {
    assertCondition(
      value === undefined || value === 200 || value === 503,
      "MOCK_STATUS_INVALID",
    );
    const method = value === undefined ? "GET" : "PUT";
    const raw = await this.execute(
      `fetch('http://127.0.0.1:8081/admin/status',{method:'${method}',headers:{authorization:'Bearer '+process.env.MOCK_TOKEN,'content-type':'application/json'},${value === undefined ? "" : `body:JSON.stringify({status:${value}}),`}signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)process.exit(2);console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))`,
    );
    const { status } = JSON.parse(raw);
    assertCondition(
      [200, 503].includes(status) && (value === undefined || status === value),
      "MOCK_CONTROL_MISMATCH",
    );
    return status as number;
  }
}
