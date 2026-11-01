/** 学習用外部IF・モック・販売アプリのHTTP入口。fixture、URL制限、各サーバーの順に読む。 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { openDb, order } from "./db.ts";
import type { DatabaseSync } from "node:sqlite";

export const fixture = {
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
};
/**
 * valueがローカルHTTPのURLか検証しURLを返す。対象外や不正なURLは例外。
 */
export function localUrl(value: string): URL {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw Error("LOCAL_URL_REQUIRED");
  return u;
}
/**
 * resへstatusとdataをJSONで返す。戻り値なし。レスポンス書込み失敗は実行環境に伝わる。
 */
function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}
/**
 * reqの本文をサイズ制限付きで読みJSONを返す。超過やJSON不正は例外。
 */
async function body(req: http.IncomingMessage) {
  let s = "";
  for await (const b of req) {
    s += b;
    if (s.length > 8192) throw Error("TOO_LARGE");
  }
  return JSON.parse(s);
}
/**
 * 学習用外部IFのサーバーを返す。mock時はtokenで管理APIを保護する。短いtokenは例外。
 * リクエストごとの異常はHTTP応答またはサーバー処理の失敗になる。
 */
export function upstreamServer(token: string, mock = false) {
  if (mock && token.length < 32) throw Error("TOKEN_REQUIRED");
  let status = 200;
  return http.createServer(async (req, res) => {
    if (req.url === "/catalog" && req.method === "GET") {
      if (status !== 200) {
        res.writeHead(status);
        return res.end();
      }
      const data = process.env.SALES_CATALOG_FILE
        ? JSON.parse(await readFile(process.env.SALES_CATALOG_FILE, "utf8"))
        : fixture;
      return json(res, 200, data);
    }
    if (mock && req.url === "/admin/status") {
      if (req.headers.authorization !== `Bearer ${token}`)
        return json(res, 401, { error: "UNAUTHORIZED" });
      if (req.method === "GET") return json(res, 200, { status });
      if (req.method === "PUT") {
        try {
          const v = await body(req);
          if (
            Object.keys(v).join() !== "status" ||
            ![200, 503].includes(v.status)
          )
            throw Error();
          status = v.status;
          return json(res, 200, { status });
        } catch {
          return json(res, 400, { error: "INVALID_REQUEST" });
        }
      }
    }
    return json(res, 404, { error: "NOT_FOUND" });
  });
}
export const page = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>販売管理</title><h1>販売管理</h1><button id="availability">外部接続確認</button><p id="availability-result" role="status"></p><button id="refresh">商品表示</button><div id="products"></div><p id="result" role="status"></p><script src="/app.js"></script></html>`;
// Consume availability's body too: with Chrome/ALB an unread fetch body can leave
// request completion (and Playwright's Response body access) pending. See #12.
export const script = `const result=document.querySelector('#result'); document.querySelector('#availability').onclick=async()=>{const r=await fetch('/api/availability');const data=await r.json();document.querySelector('#availability-result').textContent=r.ok&&data.available===true?'接続可能':'外部システムエラー'};document.querySelector('#refresh').onclick=async()=>{const r=await fetch('/api/products');const data=await r.json();const root=document.querySelector('#products');root.replaceChildren();if(!r.ok){result.textContent='商品情報に不整合があります';return}for(const p of data.products){const box=document.createElement('div');box.textContent=p.name+' '+p.price+'円 在庫'+p.quantity;const button=document.createElement('button');button.textContent='受注';button.dataset.productCode=p.productCode;button.onclick=async()=>{const response=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productCode:p.productCode,quantity:1,version:p.version})});const value=await response.json();result.textContent=response.ok?'受注しました':({INCONSISTENT_DATA:'商品情報に不整合があります',STALE_VERSION:'情報が更新されました。再表示してください',ORDER_UNAVAILABLE:'受注できません'}[value.error]||'受注できません')};box.append(button);root.append(box)}};`;
/**
 * dbとupstreamを使う販売アプリのサーバーを返す。ローカル外URLは例外。
 * リクエストの予期しない処理失敗はHTTP 500にする。
 */
export function appServer(db: DatabaseSync, upstream: string) {
  const url = localUrl(upstream);
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      if (req.method === "GET" && req.url === "/app.js") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        return res.end(script);
      }
      if (req.method === "GET" && req.url === "/api/availability") {
        try {
          const r = await fetch(new URL("/catalog", url), {
            signal: AbortSignal.timeout(3000),
            redirect: "error",
          });
          if (!r.ok) throw Error();
          await r.arrayBuffer();
          return json(res, 200, { available: true });
        } catch {
          return json(res, 502, { error: "UPSTREAM_UNAVAILABLE" });
        }
      }
      if (req.method === "GET" && req.url === "/api/products") {
        const rows = db
          .prepare(
            "SELECT p.product_code AS productCode,p.name,p.price,i.quantity,p.version FROM products p LEFT JOIN inventory i USING(product_code) WHERE p.active=1 ORDER BY p.product_code",
          )
          .all() as any[];
        if (rows.some((r) => r.quantity === null))
          return json(res, 409, { error: "INCONSISTENT_DATA" });
        return json(res, 200, { products: rows });
      }
      if (req.method === "POST" && req.url === "/api/orders") {
        let b;
        try {
          b = await body(req);
        } catch {
          return json(res, 400, { error: "INVALID_REQUEST" });
        }
        const r = order(db, b);
        return json(res, r.status, r.body);
      }
      return json(res, 404, { error: "NOT_FOUND" });
    } catch {
      return json(res, 500, { error: "INTERNAL_ERROR" });
    }
  });
}
if (import.meta.main) {
  const mode = process.argv[2];
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("PORT_REQUIRED");
  const server =
    mode === "app"
      ? appServer(openDb(process.env.SALES_DB!), process.env.UPSTREAM_URL!)
      : mode === "upstream"
        ? upstreamServer("", false)
        : mode === "mock"
          ? upstreamServer(process.env.MOCK_TOKEN!, true)
          : null;
  if (!server) throw Error("MODE_REQUIRED");
  server.listen(port, "127.0.0.1");
}
