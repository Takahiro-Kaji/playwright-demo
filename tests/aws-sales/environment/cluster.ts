import { spawn } from "node:child_process";
import { assertCondition, saveJournal, type Journal } from "./state.ts";
import { until } from "../support/polling.ts";

export type Command = (
  binary: string,
  args: string[],
  input?: string,
  timeout?: number,
) => Promise<string>;
/** シェルを使わず、出力量を制限してエラーの機密情報を除く。入出力には秘密情報が含まれ得る。 */
export const command: Command = (binary, args, input, timeout = 15000) =>
  new Promise((ok, no) => {
    const p = spawn(binary, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      size = 0,
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      p.kill("SIGKILL");
    }, timeout);
    p.stdout.on("data", (b) => {
      size += b.length;
      if (size > 4_000_000) {
        failed = true;
        p.kill("SIGKILL");
      } else out += b;
    });
    p.stderr.on("data", (b) => {
      size += b.length;
      if (size > 4_000_000) {
        failed = true;
        p.kill("SIGKILL");
      }
    });
    p.stdin.on("error", () => {});
    p.on("error", () => {
      clearTimeout(timer);
      no(Error("COMMAND_START_FAILED"));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (failed) no(Error("COMMAND_TIMEOUT_OR_LIMIT"));
      else if (code !== 0) no(Error("COMMAND_FAILED"));
      else ok(out);
    });
    p.stdin.end(input);
  });
/** AWS/Kubernetesの実行先と所有関係を確認し、リソースを操作する。 */
export class Cluster {
  readonly j: Journal;
  readonly run: Command;
  constructor(j: Journal, run: Command = command) {
    this.j = j;
    this.run = run;
  }
  async aws(service: string, ...args: string[]) {
    return JSON.parse(
      await this.run("aws", [
        "--profile",
        this.j.config.profile,
        "--region",
        this.j.config.region,
        service,
        ...args,
        "--output",
        "json",
      ]),
    );
  }
  async k(args: string[], input?: unknown, timeout?: number) {
    return this.run(
      "kubectl",
      [
        "--context",
        this.j.config.context,
        "--namespace",
        this.j.namespace,
        ...args,
      ],
      input === undefined ? undefined : JSON.stringify(input),
      timeout,
    );
  }
  async get(kind: string, name: string) {
    const s = await this.k([
      "get",
      kind,
      name,
      "--ignore-not-found",
      "-o",
      "json",
    ]);
    return s.trim() ? JSON.parse(s) : undefined;
  }
  async identity() {
    const c = this.j.config,
      who = await this.aws("sts", "get-caller-identity");
    assertCondition(who.Account === c.account, "AWS_ACCOUNT_MISMATCH");
    const { cluster } = await this.aws(
      "eks",
      "describe-cluster",
      "--name",
      c.cluster,
    );
    assertCondition(
      cluster.arn ===
        `arn:aws:eks:${c.region}:${c.account}:cluster/${c.cluster}` &&
        cluster.status === "ACTIVE",
      "EKS_IDENTITY_MISMATCH",
    );
    const cfg = JSON.parse(
      await this.run("kubectl", [
        "--context",
        c.context,
        "config",
        "view",
        "--minify",
        "--raw",
        "-o",
        "json",
      ]),
    );
    assertCondition(
      cfg.clusters?.length === 1 &&
        cfg.clusters[0].cluster.server === cluster.endpoint &&
        cfg.clusters[0].cluster["certificate-authority-data"] ===
          cluster.certificateAuthority.data &&
        !cfg.clusters[0].cluster["insecure-skip-tls-verify"],
      "KUBECONFIG_MISMATCH",
    );
    return cluster;
  }
  metadata(name: string) {
    return {
      name,
      namespace: this.j.namespace,
      labels: { "sales-run": this.j.runId, "sales-owner": this.j.owner },
    };
  }
  owned(object: any, kind: string, name: string) {
    const r = this.j.resources.find((r) => r.kind === kind && r.name === name);
    assertCondition(
      r &&
        object?.metadata?.name === name &&
        object.metadata.labels?.["sales-run"] === this.j.runId &&
        object.metadata.labels?.["sales-owner"] === this.j.owner &&
        (!r.uid || r.uid === object.metadata.uid),
      "RESOURCE_OWNERSHIP_MISMATCH",
    );
    return object;
  }
  async verify(kind: string, name: string) {
    return this.owned(await this.get(kind, name), kind, name);
  }
  async create(file: string, object: any) {
    const kind = object.kind,
      name = object.metadata.name;
    assertCondition(!(await this.get(kind, name)), "RESOURCE_ALREADY_EXISTS");
    this.j.resources.push({ kind, name });
    saveJournal(file, this.j); // 応答を失う可能性に備え、操作予定を先に記録する
    try {
      await this.k(["create", "-f", "-"], object);
    } finally {
      const actual = await this.get(kind, name);
      if (actual) {
        this.owned(actual, kind, name);
        this.j.resources.find((r) => r.kind === kind && r.name === name)!.uid =
          actual.metadata.uid;
        saveJournal(file, this.j);
      }
    }
  }
  async deleteOwned(kind: string, name: string, timeout = 120000) {
    const object = await this.get(kind, name);
    if (!object) return;
    this.owned(object, kind, name);
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
    await this.k(["delete", `--raw=${path}`, "-f", "-"], {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: {
        uid: object.metadata.uid,
        resourceVersion: object.metadata.resourceVersion,
      },
      propagationPolicy: "Foreground",
    });
    await until(
      async () => !(await this.get(kind, name)),
      timeout,
      "RESOURCE_STOP_UNCONFIRMED",
    );
  }
}
