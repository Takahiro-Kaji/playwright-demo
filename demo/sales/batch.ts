/** 学習用外部IFの取得からDB同期までの入口。runBatch、コマンド入口の順に読む。 */
import { openDb, sync, validateCatalog } from "./db.ts";
import { localUrl } from "./server.ts";
/**
 * upstreamから全JSONを取得・検証してdbPathに同期し、結果の概要を返す。
 * 通信・検証・DB更新失敗は例外。取得完了前にDB更新を始めない。
 */
export async function runBatch(dbPath: string, upstream: string, scope = "") {
  const response = await fetch(new URL("/catalog", localUrl(upstream)), {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw Error("UPSTREAM_UNAVAILABLE");
  const catalog = validateCatalog(await response.json());
  const db = openDb(dbPath);
  try {
    sync(db, catalog, scope);
  } finally {
    db.close();
  }
  return {
    status: "OK",
    catalogVersion: catalog.catalogVersion,
    count: catalog.products.length,
  };
}
if (import.meta.main) {
  try {
    const r = await runBatch(
      process.env.SALES_DB!,
      process.env.UPSTREAM_URL!,
      process.env.SALES_SCOPE || "",
    );
    console.log(JSON.stringify(r));
  } catch {
    console.error("SYNC_FAILED");
    process.exitCode = 1;
  }
}
