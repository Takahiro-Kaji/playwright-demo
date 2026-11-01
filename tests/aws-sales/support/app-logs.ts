import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Cluster } from "../environment/cluster.ts";
import {
  assertCondition,
  localPath,
  type AppLogs,
} from "../environment/state.ts";

/** ReadyでないPodも対象にし、取得失敗で復元処理を妨げない。 */
export async function collectAppLogs(
  cluster: Cluster,
  caseId: string,
  since: string,
): Promise<AppLogs> {
  const result: AppLogs = { status: "saved", files: [] };
  try {
    assertCondition(/^[A-Z0-9-]+$/.test(caseId), "LOG_CASE_ID_INVALID");
    const dep = await cluster.verify("Deployment", "sales-app");
    const pods = JSON.parse(
      await cluster.k(["get", "pods", "-l", "app=sales-app", "-o", "json"]),
    ).items;
    assertCondition(pods.length > 0, "APP_LOG_PODS_MISSING");
    const directory = `.local/aws-sales-evidence/${cluster.j.runId}/app-logs/${caseId}-${randomUUID()}`;
    for (const pod of pods) {
      try {
        const name = pod.metadata.name;
        assertCondition(
          /^[a-z0-9][a-z0-9.-]*$/.test(name) &&
            pod.metadata.labels?.["sales-run"] === cluster.j.runId &&
            pod.metadata.labels?.["sales-owner"] === cluster.j.owner,
          "APP_LOG_POD_NOT_OWNED",
        );
        const owner = pod.metadata.ownerReferences?.find(
          (o: any) => o.controller,
        );
        assertCondition(
          owner?.kind === "ReplicaSet",
          "APP_LOG_POD_OWNER_INVALID",
        );
        const rs = await cluster.get("ReplicaSet", owner.name);
        assertCondition(
          rs?.metadata.uid === owner.uid &&
            rs.metadata.ownerReferences?.some(
              (o: any) =>
                o.kind === "Deployment" &&
                o.uid === dep.metadata.uid &&
                o.controller,
            ),
          "APP_LOG_REPLICASET_OWNER_MISMATCH",
        );
        const restarted = pod.status?.containerStatuses?.some(
          (c: any) => c.name === "app" && c.restartCount > 0,
        );
        for (const previous of restarted ? [false, true] : [false]) {
          try {
            const logs = await cluster.k([
              "logs",
              name,
              "-c",
              "app",
              "--timestamps=true",
              `--since-time=${since}`,
              "--tail=10000",
              "--limit-bytes=1048576",
              ...(previous ? ["--previous"] : []),
            ]);
            const path = `${directory}/${name}${previous ? ".previous" : ""}.log`;
            writeFileSync(localPath(path), logs, { flag: "wx", mode: 0o600 });
            result.files.push(path);
          } catch {
            result.status = "failed";
          }
        }
      } catch {
        result.status = "failed";
      }
    }
  } catch {
    result.status = "failed";
  }
  return result;
}
