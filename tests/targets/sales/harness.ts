/** 各ケース専用のローカル環境と操作を用意する。harnessの起動、返す操作、cleanupの順に読む。 */
import { test } from "@playwright/test";
import { snapshotSales } from "./snapshot.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
/**
 * 空きポートを一時確保して番号を返す。引数なし。確保に失敗するとPromiseがrejectされる。
 */
async function port(): Promise<number> {
  return new Promise((ok, no) => {
    const s = createServer();
    s.once("error", no);
    s.listen(0, "127.0.0.1", () => {
      const n = (s.address() as any).port;
      s.close(() => ok(n));
    });
  });
}
/**
 * 指定URLへの接続を繰り返し起動を待つ。urlは確認先、pは対象プロセス。戻り値はなし。
 * プロセス終了または期限切れなら例外になる。
 */
async function wait(url: string, p: ChildProcess) {
  for (let n = 0; n < 100; n++) {
    if (p.exitCode !== null) throw Error("PROCESS_EXIT");
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw Error("PROCESS_START_TIMEOUT");
}
/**
 * ケース専用DBとサーバーを起動し操作一式を返す。modeは実HTTP用IFか制御可能モック。
 * 起動失敗時は回収を試み、失敗を例外で知らせる。
 */
export async function harness(mode: "upstream" | "mock") {
  const id = randomUUID(),
    dir = resolve(`.local/sales-learning/${id}`);
  await mkdir(dir, { recursive: true });
  const db = dir + "/sales.sqlite";
  const catalog = dir + "/catalog.json";
  await writeFile(
    catalog,
    JSON.stringify({
      catalogVersion: 1,
      products: [
        {
          productCode: "P001",
          name: "ペン",
          price: 120,
          active: true,
          quantity: 5,
        },
        {
          productCode: "P002",
          name: "ノート",
          price: 300,
          active: true,
          quantity: 2,
        },
      ],
    }),
  );
  const upPort = await port(),
    appPort = await port();
  const upstream = `http://127.0.0.1:${upPort}`,
    app = `http://127.0.0.1:${appPort}`,
    token = randomUUID() + randomUUID();
  const processes: ChildProcess[] = [];
  const closed = new Map<ChildProcess, Promise<void>>();
  /** 子プロセスを起動する。argsは引数、envは追加環境変数。プロセスを返し、終了通知も保存する。 */
  function run(args: string[], env: Record<string, string>) {
    const p = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    processes.push(p);
    closed.set(
      p,
      new Promise((resolve) => {
        p.once("close", () => resolve());
        p.once("error", () => resolve());
      }),
    );
    return p;
  }
  try {
    const up = run(["demo/sales/server.ts", mode], {
      PORT: String(upPort),
      MOCK_TOKEN: token,
      SALES_CATALOG_FILE: catalog,
    });
    await wait(upstream + "/catalog", up);
    const appProc = run(["demo/sales/server.ts", "app"], {
      PORT: String(appPort),
      SALES_DB: db,
      UPSTREAM_URL: upstream,
    });
    await wait(app + "/", appProc);
  } catch (error) {
    try {
      await cleanup();
    } catch {
      throw new AggregateError(
        [error],
        `START_FAILED_CLEANUP_UNCONFIRMED: ${dir}`,
      );
    }
    throw error;
  }
  /** 同期を別プロセスで実行する。引数なし、終了コードを返す。起動エラーならrejectする。 */
  async function batch() {
    return new Promise<number>((ok, no) => {
      const p = run(["demo/sales/batch.ts"], {
        SALES_DB: db,
        UPSTREAM_URL: upstream,
      });
      p.once("error", no);
      p.once("close", (code) => ok(code ?? -1));
    });
  }
  /** モック管理値を読むか変更する。value省略で取得、指定で設定。現在値を返し管理失敗時は例外。 */
  async function status(value?: number) {
    const r = await fetch(upstream + "/admin/status", {
      method: value === undefined ? "GET" : "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(value === undefined
        ? {}
        : { body: JSON.stringify({ status: value }) }),
    });
    if (!r.ok) throw Error("MOCK_CONTROL");
    return ((await r.json()) as any).status;
  }
  /** 独立接続でSELECTする。sqlとプレースホルダー用argsを受け、行配列を返す。SQL失敗は例外。 */
  function query(sql: string, ...args: any[]) {
    const d = new DatabaseSync(db);
    try {
      d.exec("PRAGMA foreign_keys=ON");
      return d.prepare(sql).all(...args);
    } finally {
      d.close();
    }
  }
  /** 専用DBに準備用SQLを実行する。sqlとargsを受け、戻り値なし。失敗は例外。 */
  function execute(sql: string, ...args: any[]) {
    const d = new DatabaseSync(db);
    try {
      d.exec("PRAGMA foreign_keys=ON");
      d.prepare(sql).run(...args);
    } finally {
      d.close();
    }
  }
  /** 4表を一貫して取得する。引数なし、取得状態を返す。取得失敗は例外。 */
  function snapshot() {
    const d = new DatabaseSync(db);
    try {
      return snapshotSales(d);
    } finally {
      d.close();
    }
  }
  /** 子プロセスの終了を確認し必要ならDBを削除する。preserveがtrueなら保持。戻り値なし、終了未確認は例外。 */
  async function cleanup(preserve = false) {
    const unknown: number[] = [];
    for (const p of processes) {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      // killの送信だけでは終了の証拠にならない。closeと期限の早い方を待つ。
      const confirmed = await Promise.race([
        closed.get(p)!.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!confirmed) unknown.push(p.pid ?? -1);
    }
    if (unknown.length)
      throw Error(
        `PROCESS_STOP_UNCONFIRMED: ${dir}; pids=${unknown.join(",")}`,
      );
    if (!preserve) await rm(dir, { recursive: true, force: true });
    test.info().annotations.push({
      type: "after",
      description: preserve ? "要復旧・DB保持" : "停止確認・専用DB削除済み",
    });
  }
  return {
    app,
    upstream,
    db,
    dir,
    catalog,
    batch,
    status,
    query,
    execute,
    snapshot,
    cleanup,
  };
}
