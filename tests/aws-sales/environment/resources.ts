import { readFileSync } from "node:fs";
import type { Journal } from "./state.ts";
import { salesFixture } from "../upstream/fixtures.ts";

export function manifests(j: Journal) {
  const c = j.config,
    labels = { "sales-run": j.runId, "sales-owner": j.owner };
  const meta = (name: string) => ({ name, namespace: j.namespace, labels });
  const securityContext = {
    runAsNonRoot: true,
    runAsUser: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  };
  const containerSecurity = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  const dbEnv = [
    { name: "DB_HOST", value: c.dbHost },
    { name: "DB_NAME", value: j.database },
    ...["USER", "PASSWORD"].map((x) => ({
      name: `DB_${x}`,
      valueFrom: { secretKeyRef: { name: "sales-db", key: x.toLowerCase() } },
    })),
    { name: "DB_CA_FILE", value: "/certs/global-bundle.pem" },
    { name: "UPSTREAM_URL", value: "http://sales-upstream:8081/" },
  ];
  const mounts = [{ name: "rds-ca", mountPath: "/certs", readOnly: true }],
    volumes = [{ name: "rds-ca", configMap: { name: "rds-ca" } }];
  const batch = {
    name: "batch",
    image: c.image,
    command: ["node", "aws/sales/runtime.ts", "batch"],
    env: dbEnv,
    volumeMounts: mounts,
    securityContext: containerSecurity,
  };
  return {
    namespace: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: j.namespace, labels },
    },
    bridge: {
      apiVersion: "v1",
      kind: "Pod",
      metadata: meta("sales-db-bridge"),
      spec: {
        automountServiceAccountToken: false,
        securityContext,
        containers: [
          {
            name: "bridge",
            image: c.image,
            command: ["node", "-e", "setInterval(()=>{},60000)"],
            env: [{ name: "DB_HOST", value: c.dbHost }],
            securityContext: containerSecurity,
          },
        ],
      },
    },
    secret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta("sales-db"),
      type: "Opaque",
      stringData: { user: j.user, password: j.password },
    },
    mockSecret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta("sales-mock"),
      type: "Opaque",
      stringData: { token: j.mockToken },
    },
    ca: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta("rds-ca"),
      data: { "global-bundle.pem": readFileSync(c.caFile, "utf8") },
    },
    catalog: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta("sales-catalog"),
      data: { "catalog.json": JSON.stringify(salesFixture("f1")) },
    },
    upstream: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta("sales-upstream"),
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: "sales-upstream", ...labels } },
        template: {
          metadata: { labels: { app: "sales-upstream", ...labels } },
          spec: {
            automountServiceAccountToken: false,
            securityContext,
            containers: [
              {
                name: "upstream",
                image: c.image,
                command: ["node", "aws/sales/runtime.ts", "upstream"],
                env: [
                  { name: "PORT", value: "8081" },
                  {
                    name: "SALES_CATALOG_FILE",
                    value: "/catalog/catalog.json",
                  },
                  {
                    name: "MOCK_TOKEN",
                    valueFrom: {
                      secretKeyRef: { name: "sales-mock", key: "token" },
                    },
                  },
                ],
                ports: [{ name: "http", containerPort: 8081 }],
                volumeMounts: [
                  { name: "catalog", mountPath: "/catalog", readOnly: true },
                ],
                securityContext: containerSecurity,
              },
            ],
            volumes: [
              { name: "catalog", configMap: { name: "sales-catalog" } },
            ],
          },
        },
      },
    },
    upstreamService: {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta("sales-upstream"),
      spec: {
        selector: { app: "sales-upstream", ...labels },
        ports: [{ port: 8081, targetPort: "http" }],
      },
    },
    app: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta("sales-app"),
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "sales-app", ...labels } },
        template: {
          metadata: { labels: { app: "sales-app", ...labels } },
          spec: {
            automountServiceAccountToken: false,
            securityContext,
            volumes,
            containers: [
              {
                name: "app",
                image: c.image,
                env: [...dbEnv, { name: "PORT", value: "8080" }],
                ports: [{ name: "http", containerPort: 8080 }],
                volumeMounts: mounts,
                securityContext: containerSecurity,
                readinessProbe: {
                  httpGet: { path: "/healthz", port: "http" },
                  periodSeconds: 3,
                },
              },
            ],
          },
        },
      },
    },
    service: {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta("sales-app"),
      spec: {
        selector: { app: "sales-app", ...labels },
        ports: [{ port: 8080, targetPort: "http" }],
      },
    },
    cron: {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: meta("sales-batch"),
      spec: {
        schedule: "0 0 1 1 *",
        suspend: true,
        concurrencyPolicy: "Forbid",
        jobTemplate: {
          metadata: { labels },
          spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: 180,
            template: {
              metadata: { labels },
              spec: {
                automountServiceAccountToken: false,
                restartPolicy: "Never",
                securityContext,
                volumes,
                containers: [batch],
              },
            },
          },
        },
      },
    },
    ingress: {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        ...meta("sales-sso"),
        labels: { ...labels, "app.kubernetes.io/part-of": "sales-aws-demo" },
        annotations: {
          "alb.ingress.kubernetes.io/scheme": "internet-facing",
          "alb.ingress.kubernetes.io/target-type": "ip",
          "alb.ingress.kubernetes.io/listen-ports": '[{"HTTPS":443}]',
          "alb.ingress.kubernetes.io/certificate-arn": c.certificateArn,
          "alb.ingress.kubernetes.io/inbound-cidrs": c.operatorCidr,
          "alb.ingress.kubernetes.io/healthcheck-path": "/healthz",
          "alb.ingress.kubernetes.io/auth-type": "cognito",
          "alb.ingress.kubernetes.io/auth-on-unauthenticated-request":
            "authenticate",
          "alb.ingress.kubernetes.io/auth-idp-cognito": JSON.stringify({
            userPoolARN: c.userPoolArn,
            userPoolClientID: c.userPoolClientId,
            userPoolDomain: c.userPoolDomain,
          }),
        },
      },
      spec: {
        ingressClassName: "alb",
        rules: [
          {
            host: new URL(c.url).hostname,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: { name: "sales-app", port: { number: 8080 } },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  };
}
