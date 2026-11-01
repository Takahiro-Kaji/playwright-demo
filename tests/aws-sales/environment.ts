import { hostname as requireHost } from "node:os";
import {
  readFileSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { resolve, sep, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

export type Config = {
  account: string;
  region: "ap-northeast-1" | "ap-northeast-3";
  profile: string;
  context: string;
  cluster: string;
  image: string;
  dbHost: string;
  caFile: string;
  url: string;
  stateFile: string;
  certificateArn: string;
  operatorCidr: string;
  userPoolArn: string;
  userPoolClientId: string;
  userPoolDomain: string;
};
export type Resource = { kind: string; name: string; uid?: string };
export type Journal = {
  version: 1;
  runId: string;
  owner: string;
  config: Config;
  namespace: string;
  database: string;
  user: string;
  password: string;
  mockToken: string;
  resources: Resource[];
  dbCreated: boolean;
  dbOwned: boolean;
  userCreated: boolean;
  dbIntent?: boolean;
  userIntent?: boolean;
  blocked: boolean;
  phase: string;
  lastErrors?: string[];
  execution?: {
    exitCode: number;
    cleanup: "pending" | "confirmed" | "failed";
    codes: string[];
  };
  cleanupStops?: {
    app: "confirmed" | "unconfirmed";
    jobs: "confirmed" | "unconfirmed";
    reasons: string[];
  };
  batches?: import("./batch-result.ts").BatchResult[];
  results: CaseResult[];
};
export type CaseResult = {
  id: string;
  verdict: "passed" | "failed" | "unconfirmed";
  after: "confirmed" | "failed";
  codes: string[];
  observations?: unknown;
  differences?: Record<string, number>;
};
export function assertCondition(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
export function localPath(path: string) {
  const root = resolve(".local") + sep,
    full = resolve(path);
  assertCondition(full.startsWith(root), "LOCAL_PATH_REQUIRED");
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  assertCondition(
    realpathSync(dirname(full)) === realpathSync(".local") ||
      realpathSync(dirname(full)).startsWith(realpathSync(".local") + sep),
    "LOCAL_PATH_SYMLINK",
  );
  if (existsSync(full))
    assertCondition(
      realpathSync(full).startsWith(realpathSync(".local") + sep),
      "LOCAL_FILE_SYMLINK",
    );
  return full;
}
export function validateConfig(c: Config): Config {
  assertCondition(
    c &&
      /^\d{12}$/.test(c.account) &&
      ["ap-northeast-1", "ap-northeast-3"].includes(c.region),
    "AWS_IDENTITY_CONFIG_INVALID",
  );
  for (const v of [c.profile, c.context, c.cluster])
    assertCondition(
      typeof v === "string" &&
        /^[a-zA-Z0-9_./:@-]+$/.test(v) &&
        !v.startsWith("-"),
      "TARGET_CONFIG_INVALID",
    );
  assertCondition(
    /^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(c.dbHost),
    "DB_HOST_INVALID",
  );
  assertCondition(
    new RegExp(
      `^${c.account}\\.dkr\\.ecr\\.${c.region}\\.amazonaws\\.com/[a-z0-9._/-]+:[a-zA-Z0-9._-]+$`,
    ).test(c.image),
    "IMAGE_INVALID",
  );
  const u = new URL(c.url);
  assertCondition(
    u.protocol === "https:" &&
      u.pathname === "/" &&
      !u.port &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password,
    "UI_URL_INVALID",
  );
  assertCondition(
    c.certificateArn.startsWith(
      `arn:aws:acm:${c.region}:${c.account}:certificate/`,
    ),
    "CERTIFICATE_INVALID",
  );
  assertCondition(
    c.userPoolArn.startsWith(
      `arn:aws:cognito-idp:${c.region}:${c.account}:userpool/`,
    ),
    "USER_POOL_INVALID",
  );
  assertCondition(
    /^[a-zA-Z0-9]+$/.test(c.userPoolClientId) &&
      /^[a-z0-9-]+$/.test(c.userPoolDomain),
    "COGNITO_INVALID",
  );
  assertCondition(
    /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[1-9]|[12]\d|3[0-2])$/.test(c.operatorCidr) &&
      c.operatorCidr
        .split("/")[0]
        .split(".")
        .every((n) => Number(n) <= 255),
    "CIDR_INVALID",
  );
  c.stateFile = localPath(c.stateFile);
  assertCondition(
    c.stateFile.startsWith(resolve(".local/auth") + sep),
    "AUTH_STATE_PATH_INVALID",
  );
  assertCondition(Boolean(readFileSync(c.caFile).length), "DB_CA_REQUIRED");
  return c;
}
export function loadConfig(file: string): Config {
  return validateConfig(JSON.parse(readFileSync(localPath(file), "utf8")));
}
export function newJournal(config: Config): Journal {
  const runId = randomBytes(16).toString("hex");
  return {
    version: 1,
    runId,
    owner: randomBytes(24).toString("hex"),
    config,
    namespace: `sales-test-${runId}`,
    database: `sales_test_${runId}`,
    user: `st_${runId.slice(0, 24)}`,
    password: randomBytes(32).toString("hex"),
    mockToken: randomBytes(32).toString("hex"),
    resources: [],
    dbCreated: false,
    dbOwned: false,
    userCreated: false,
    blocked: false,
    phase: "new",
    results: [],
  };
}
export function validateJournal(j: Journal) {
  assertCondition(
    j.version === 1 &&
      /^[a-f0-9]{32}$/.test(j.runId) &&
      /^[a-f0-9]{48}$/.test(j.owner),
    "JOURNAL_INVALID",
  );
  assertCondition(
    j.namespace === `sales-test-${j.runId}` &&
      j.database === `sales_test_${j.runId}` &&
      j.user === `st_${j.runId.slice(0, 24)}`,
    "JOURNAL_TARGET_INVALID",
  );
  assertCondition(
    /^[a-f0-9]{64}$/.test(j.password) && /^[a-f0-9]{64}$/.test(j.mockToken),
    "JOURNAL_SECRET_INVALID",
  );
  validateConfig(j.config);
  return j;
}
export function loadJournal(file: string) {
  return validateJournal(JSON.parse(readFileSync(localPath(file), "utf8")));
}
export function saveJournal(file: string, j: Journal) {
  const full = localPath(file),
    temp = full + "." + randomBytes(8).toString("hex") + ".tmp";
  writeFileSync(temp, JSON.stringify(j), { mode: 0o600, flag: "wx" });
  renameSync(temp, full);
}
export function exclusive(file: string) {
  const path = localPath(file) + ".lock";
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(
    fd,
    JSON.stringify({
      pid: process.pid,
      host: requireHost(),
      started: new Date().toISOString(),
    }),
  );
  return () => {
    closeSync(fd);
    unlinkSync(path);
  };
}
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
}

export function unlockStale(file: string) {
  const path = localPath(file) + ".lock";
  const lock = JSON.parse(readFileSync(path, "utf8"));
  assertCondition(
    lock.host === requireHost() && Number.isInteger(lock.pid) && lock.pid > 0,
    "LOCK_OWNER_UNKNOWN",
  );
  let gone = false;
  try {
    process.kill(lock.pid, 0);
  } catch (e: any) {
    gone = e.code === "ESRCH";
  }
  assertCondition(gone, "LOCK_OWNER_STILL_RUNNING");
  unlinkSync(path);
}

export function errorCodes(error: unknown): string[] {
  if (error instanceof AggregateError)
    return [
      ...(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? [error.message] : []),
      ...error.errors.flatMap(errorCodes),
    ];
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message))
    return [error.message];
  const code = (error as any)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)
    ? [code]
    : ["OPERATION_FAILED"];
}
