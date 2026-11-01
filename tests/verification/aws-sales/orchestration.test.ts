import { fixture } from "./fixtures.ts";
import { test } from "node:test";
import { strict as a } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  newJournal,
  Cluster,
  validateConfig,
  validateJournal,
  type Config,
  type Command,
} from "../../aws-sales/environment.ts";
import { manifests } from "../../aws-sales/resources.ts";
import { Environment, checkEnv, until } from "../../aws-sales/lifecycle.ts";
import { mkdirSync } from "node:fs";

test("対象が変わったら設定と復旧記録の検証で処理を止める", () => {
  const f = fixture();
  try {
    a.throws(() =>
      validateConfig({ ...f.j.config, url: "http://example.com/" }),
    );
    a.throws(() =>
      validateConfig({ ...f.j.config, region: "us-east-1" as any }),
    );
    a.throws(() => validateJournal({ ...f.j, database: "integration_demo" }));
    a.throws(() => validateJournal({ ...f.j, namespace: "integration-demo" }));
  } finally {
    f.close();
  }
});
test("PodとバッチのDB識別確認で別スキーマ・接続ユーザーを拒否する", () => {
  const f = fixture();
  try {
    const app = manifests(f.j).app.spec.template.spec.containers[0];
    a.doesNotThrow(() => checkEnv(app, f.j));
    const bad = structuredClone(app);
    (bad.env.find((e: any) => e.name === "DB_NAME") as any).value =
      "integration_demo";
    a.throws(() => checkEnv(bad, f.j));
  } finally {
    f.close();
  }
});
test("作成応答を失ったら所有するUIDだけを照合して記録する", async () => {
  const f = fixture();
  let exists = false;
  const object = manifests(f.j).bridge;
  const actual = { ...object, metadata: { ...object.metadata, uid: "uid-1" } };
  const run: Command = async (_b, args) => {
    if (args.includes("create")) {
      exists = true;
      throw Error("lost");
    }
    return exists ? JSON.stringify(actual) : "";
  };
  try {
    const cluster = new Cluster(f.j, run);
    await a.rejects(cluster.create(f.file, object));
    a.equal(f.j.resources[0].uid, "uid-1");
    a.equal(JSON.parse(readFileSync(f.file, "utf8")).resources[0].uid, "uid-1");
  } finally {
    f.close();
  }
});
test("既存リソースを流用・変更しない", async () => {
  const f = fixture();
  let creates = 0;
  const object = manifests(f.j).bridge;
  const run: Command = async (_b, args) => {
    if (args.includes("create")) creates++;
    return JSON.stringify(object);
  };
  try {
    await a.rejects(new Cluster(f.j, run).create(f.file, object));
    a.equal(creates, 0);
    a.equal(f.j.resources.length, 0);
  } finally {
    f.close();
  }
});
test("リソースのラベルで記録済みUIDの不一致を許可しない", () => {
  const f = fixture();
  try {
    f.j.resources.push({ kind: "Job", name: "job", uid: "old" });
    a.throws(() =>
      new Cluster(f.j).owned(
        {
          metadata: {
            name: "job",
            uid: "new",
            labels: { "sales-run": f.j.runId, "sales-owner": f.j.owner },
          },
        },
        "Job",
        "job",
      ),
    );
  } finally {
    f.close();
  }
});
test("Jobの停止失敗で後続を止め元の処理失敗を保持する", async () => {
  const f = fixture();
  const env = new Environment(f.file, f.j);
  env.cluster.verify = async () => manifests(f.j).cron;
  env.cluster.create = async () => {
    throw Error("start response lost");
  };
  env.deleteOwned = async () => {
    throw Error("stop failed");
  };
  try {
    await a.rejects(
      env.batch(),
      (e: any) => e instanceof AggregateError && e.errors.length === 2,
    );
    a.equal(f.j.blocked, true);
  } finally {
    f.close();
  }
});
test("上流の復元を試みても書き込み処理の停止が不明ならDBを初期化しない", async () => {
  const f = fixture();
  const env = new Environment(f.file, f.j);
  const called: string[] = [];
  env.stopJobs = async () => {
    throw Error("unknown writer");
  };
  env.catalog = async () => {
    called.push("catalog");
  };
  env.reset = async () => {
    called.push("reset");
  };
  try {
    await a.rejects(env.restore({} as any));
    a.deepEqual(called, ["catalog"]);
    a.equal(f.j.blocked, true);
  } finally {
    f.close();
  }
});
test("モック管理応答と実際のHTTP状態を別々に検証する", async () => {
  const f = fixture();
  const env = new Environment(f.file, f.j);
  try {
    env.execUpstream = async () => JSON.stringify({ status: 503 });
    a.equal(await env.mockStatus(503), 503);
    await a.rejects(env.mockStatus(200));
    env.execUpstream = async () =>
      JSON.stringify({ status: 200, hash: "incorrect" });
    await a.rejects(env.catalogMatches("f1"));
  } finally {
    f.close();
  }
});
test("ポーリングの期限切れを成功にしない", async () => {
  await a.rejects(
    until(async () => false, 1, "TEST_TIMEOUT", 1),
    /TEST_TIMEOUT/,
  );
});

test("通常URLが別のALB配下のPodに届いたら対象照合で拒否する", async () => {
  const f = fixture();
  const env = new Environment(f.file, f.j);
  const m = manifests(f.j);
  const p = {
    metadata: { uid: "pod-uid" },
    status: { podIP: "10.0.0.3" },
    spec: { volumes: [{ name: "rds-ca", configMap: { name: "rds-ca" } }] },
  };
  env.cluster.identity = async () => ({
    resourcesVpcConfig: { vpcId: "vpc-1" },
  });
  env.bridge = async () => ({});
  env.pod = async () => p;
  let correct = false;
  env.pool = async () => ({ end: async () => {} }) as any;
  env.dbOwner = async () => {};
  env.cluster.verify = async (kind, name) =>
    kind === "Service"
      ? m.service
      : kind === "Ingress"
        ? {
            ...m.ingress,
            status: {
              loadBalancer: {
                ingress: [{ hostname: "test.elb.amazonaws.com" }],
              },
            },
          }
        : kind === "CronJob"
          ? m.cron
          : kind === "ConfigMap"
            ? m.ca
            : kind === "Secret"
              ? {
                  data:
                    name === "sales-db"
                      ? {
                          user: Buffer.from(f.j.user).toString("base64"),
                          password: Buffer.from(f.j.password).toString(
                            "base64",
                          ),
                        }
                      : {
                          token: Buffer.from(f.j.mockToken).toString("base64"),
                        },
                }
              : {};
  env.cluster.get = async () => ({
    subsets: [
      {
        addresses: [{ ip: p.status.podIP, targetRef: { uid: p.metadata.uid } }],
      },
    ],
  });
  env.cluster.aws = async (_service, operation) => {
    if (operation === "describe-load-balancers")
      return {
        LoadBalancers: [
          {
            DNSName: "test.elb.amazonaws.com",
            VpcId: "vpc-1",
            Scheme: "internet-facing",
            State: { Code: "active" },
            LoadBalancerArn: "lb",
          },
        ],
      };
    if (operation === "describe-listeners")
      return {
        Listeners: [
          {
            Port: 443,
            Protocol: "HTTPS",
            Certificates: [{ CertificateArn: f.j.config.certificateArn }],
            ListenerArn: "listener",
          },
        ],
      };
    if (operation === "describe-rules")
      return {
        Rules: [
          {
            Conditions: [
              { Field: "host-header", Values: ["test.example.com"] },
            ],
            Actions: [
              {
                Type: "authenticate-cognito",
                AuthenticateCognitoConfig: {
                  UserPoolArn: f.j.config.userPoolArn,
                  UserPoolClientId: f.j.config.userPoolClientId,
                  UserPoolDomain: f.j.config.userPoolDomain,
                  OnUnauthenticatedRequest: "authenticate",
                },
              },
              { Type: "forward", TargetGroupArn: "tg" },
            ],
          },
        ],
      };
    return {
      TargetHealthDescriptions: [
        {
          Target: { Id: correct ? p.status.podIP : "10.0.0.99", Port: 8080 },
          TargetHealth: { State: "healthy" },
        },
      ],
    };
  };
  try {
    await a.rejects(env.verifyTarget(false), /ALB_TARGET_MISMATCH/);
    correct = true;
    await env.verifyTarget(false);
    m.ingress.spec.rules[0].host = "regular.example.com";
    await a.rejects(env.verifyTarget(false), /INGRESS_TARGET_MISMATCH/);
  } finally {
    f.close();
  }
});

test("AWSの識別情報とkubeconfigのCAの変化を更新前に拒否する", async () => {
  const f = fixture();
  let account = "999999999999";
  const run: Command = async (binary, args) => {
    if (args.includes("get-caller-identity"))
      return JSON.stringify({ Account: account });
    if (args.includes("describe-cluster"))
      return JSON.stringify({
        cluster: {
          arn: `arn:aws:eks:${f.j.config.region}:${f.j.config.account}:cluster/${f.j.config.cluster}`,
          status: "ACTIVE",
          endpoint: "https://eks.example.com",
          certificateAuthority: { data: "expected" },
        },
      });
    return JSON.stringify({
      clusters: [
        {
          cluster: {
            server: "https://eks.example.com",
            "certificate-authority-data": "wrong",
          },
        },
      ],
    });
  };
  try {
    const c = new Cluster(f.j, run);
    await a.rejects(c.identity(), /AWS_ACCOUNT_MISMATCH/);
    account = f.j.config.account;
    await a.rejects(c.identity(), /KUBECONFIG_MISMATCH/);
  } finally {
    f.close();
  }
});
