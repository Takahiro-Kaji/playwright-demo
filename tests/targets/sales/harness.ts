/** 各ケース専用のローカル環境と操作を用意する。harnessの起動、返す操作、cleanupの順に読む。 */
import { isDeepStrictEqual } from "node:util";
import { openDb } from "../../../demo/sales/db.ts";
import type { Catalog } from "../../../demo/sales/db.ts";
import { test } from "@playwright/test";
import { snapshotSales } from "./snapshot.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
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
 * 共通DB上のケース所有データとローカルサーバーの操作一式を返す。modeは実HTTP用IFか制御可能モック。
 * 起動失敗時は回収を試み、失敗を例外で知らせる。
 */
export async function harness(mode: "upstream" | "mock") {
  const id = randomUUID(),
    dir = resolve(`.local/sales-learning/${id}`);
  await mkdir(dir, { recursive: true });
  // DBファイルは全ケース・再実行で共有。空にせず、このケースのキーだけを使う。
  const db = resolve(".local/sales-learning/shared/sales.sqlite");
  await mkdir(resolve(".local/sales-learning/shared"), { recursive: true });
  const lock = resolve(".local/sales-learning/shared/active-test");
  try {
    await mkdir(lock);
  } catch {
    await rm(dir, { recursive: true, force: true });
    throw Error(
      "SHARED_DB_BUSY: active-testを確認。実行中または前回の復旧が未完了です",
    );
  }
  const scope = `test-${id}:`;
  const code = (value: string) => scope + value;
  const scopedCatalog = (value: Catalog): Catalog => ({
    ...value,
    products: value.products.map((p) => ({
      ...p,
      productCode: code(p.productCode),
    })),
  });
  await writeFile(
    lock + "/owner.json",
    JSON.stringify({ pid: process.pid, db, dir, scope }),
  );
  const initialDb = openDb(db);
  const baseline = snapshotSales(initialDb);
  const baselineScopes = initialDb
    .prepare("SELECT * FROM sales_sync_scopes ORDER BY scope")
    .all();
  initialDb.close();
  const catalog = dir + "/catalog.json";
  await writeFile(
    catalog,
    JSON.stringify(
      scopedCatalog({
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
    ),
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
    writeFileSync(
      lock + "/owner.json",
      JSON.stringify({
        pid: process.pid,
        db,
        dir,
        scope,
        children: processes
          .map((child) => child.pid)
          .filter((pid) => pid !== undefined),
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
      SALES_SCOPE: scope,
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
    return new Promise<number>((resolve, reject) => {
      const p = run(["demo/sales/batch.ts"], {
        SALES_DB: db,
        UPSTREAM_URL: upstream,
        SALES_SCOPE: scope,
      });
      p.once("error", reject);
      p.once("close", (code) => resolve(code ?? -1));
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
  /** 共通DBの所有行に準備用SQLを実行する。sqlとargsを受け、戻り値なし。失敗は例外。 */
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
      return snapshotSales(d, scope);
    } finally {
      d.close();
    }
  }
  /** 子プロセスの終了を確認し所有行だけを削除する。preserveがtrueなら復旧待ちで停止。戻り値なし、終了未確認は例外。 */
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
    if (!preserve) {
      const d = openDb(db);
      try {
        d.exec("BEGIN IMMEDIATE");
        try {
          // 子→親の順で、このケースの所有行だけを削除する。
          for (const table of ["orders", "inventory", "products"])
            d.prepare(`DELETE FROM ${table} WHERE product_code GLOB ?`).run(
              scope + "*",
            );
          d.prepare("DELETE FROM sales_sync_scopes WHERE scope=?").run(scope);
          d.exec("COMMIT");
        } catch (error) {
          d.exec("ROLLBACK");
          throw error;
        }
        if (
          !isDeepStrictEqual(snapshotSales(d), baseline) ||
          !isDeepStrictEqual(
            d.prepare("SELECT * FROM sales_sync_scopes ORDER BY scope").all(),
            baselineScopes,
          )
        )
          throw Error(
            "EXISTING_DATA_CHANGED: shared DBとowner.jsonを確認してください",
          );
      } finally {
        d.close();
      }
      await rm(dir, { recursive: true, force: true });
      await rm(lock, { recursive: true });
    } else {
      throw Error(
        `RECOVERY_REQUIRED: DB・所有データ・ロックを保持: ${lock}/owner.json`,
      );
    }
    test.info().annotations.push({
      type: "after",
      description: "停止確認・今回のデータのみ削除・既存データ不変",
    });
  }
  return {
    scope,
    code,
    scopedCatalog,
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
