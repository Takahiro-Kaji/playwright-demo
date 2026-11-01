import { readFileSync } from "node:fs";
import { resolve4, resolveCname } from "node:dns/promises";
import type { Cluster } from "./cluster.ts";
import type { SalesDatabase } from "../database/database.ts";
import { checkEnv, type Workloads } from "./workloads.ts";
import { assertCondition, type Journal } from "./state.ts";

/** UI経路とバッチ経路それぞれの実接続先を、変更前に照合する。 */
export class TargetVerifier {
  readonly j: Journal;
  readonly cluster: Cluster;
  readonly database: SalesDatabase;
  readonly workloads: Workloads;
  constructor(
    j: Journal,
    cluster: Cluster,
    database: SalesDatabase,
    workloads: Workloads,
  ) {
    this.j = j;
    this.cluster = cluster;
    this.database = database;
    this.workloads = workloads;
  }
  async verifyUi(dns = true) {
    const eks = await this.cluster.identity();
    await this.cluster.verify("Namespace", this.j.namespace);
    await this.database.bridge();
    const p = await this.workloads.pod("sales-app"),
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
  async verifyBatch() {
    await this.cluster.identity();
    await this.cluster.verify("Namespace", this.j.namespace);
    await this.database.bridge();
    await this.verifyDatabaseAndBatch();
  }
  private async verifyDatabaseAndBatch() {
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
    const db = await this.database.pool();
    try {
      await this.database.verifyOwner(db);
    } finally {
      await db.end();
    }
  }
}
