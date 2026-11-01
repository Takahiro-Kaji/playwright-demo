import { test } from "node:test";
import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openDb, sync, order } from "../../../demo/sales/db.ts";
import { appServer, fixture } from "../../../demo/sales/server.ts";
import { snapshotSales } from "../../targets/sales/snapshot.ts";
import { compareCatalog } from "../../targets/sales/compare.ts";

test("共有DBでスコープ内の同期・表示・受注が既存データを維持する", async () => {
  const dir = `.local/sales-learning/${randomUUID()}`;
  mkdirSync(dir, { recursive: true });
  const db = openDb(`${dir}/sales.sqlite`);
  const scope = `test-${randomUUID()}:`;
  const catalog = {
    ...fixture,
    products: fixture.products.map((p) => ({
      ...p,
      productCode: scope + p.productCode,
    })),
  };
  let upstreamStatus = 200;
  let upstreamRequests = 0;
  const upstream = createServer((req, res) => {
    assert.equal(req.url, "/catalog");
    upstreamRequests++;
    res.writeHead(upstreamStatus, { "content-type": "application/json" });
    res.end(upstreamStatus === 200 ? JSON.stringify(catalog) : "");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamPort = (upstream.address() as { port: number }).port;
  const server = appServer(db, `http://127.0.0.1:${upstreamPort}`, scope);
  try {
    sync(db, fixture);
    assert.equal(
      order(db, { productCode: "P001", quantity: 1, version: 1 }).status,
      201,
    );
    const existing = () => ({
      products: db
        .prepare(
          "SELECT * FROM products WHERE product_code IN ('P001','P002') ORDER BY product_code",
        )
        .all(),
      inventory: db
        .prepare(
          "SELECT * FROM inventory WHERE product_code IN ('P001','P002') ORDER BY product_code",
        )
        .all(),
      orders: db
        .prepare(
          "SELECT * FROM orders WHERE product_code IN ('P001','P002') ORDER BY order_id",
        )
        .all(),
      syncState: db.prepare("SELECT * FROM sync_state WHERE id=1").all(),
    });
    const before = existing();
    const owned = () => ({
      sync: snapshotSales(db, scope, { kind: "sync" }),
      order: snapshotSales(db, scope, {
        kind: "order",
      }),
    });
    sync(db, catalog, scope);
    assert.deepEqual(
      compareCatalog(
        db,
        {
          products: catalog.products.map((p) => ({ ...p, version: 1 })),
          deleted: [],
          catalogVersion: 1,
          orders: [],
        },
        scope,
      ),
      [],
    );
    const after = owned();
    assert.throws(() => sync(db, fixture, scope), /CATALOG_OUTSIDE_SCOPE/);
    assert.deepEqual(owned(), after);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const products = (await (await fetch(url + "/api/products")).json()) as any;
    assert.deepEqual(
      products.products.map((p: any) => p.productCode),
      catalog.products.map((p) => p.productCode),
    );
    const forbidden = await fetch(url + "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productCode: "P001", quantity: 1, version: 2 }),
    });
    assert.equal(forbidden.status, 400);
    assert.equal(upstreamRequests, 0);
    const submit = (quantity = 1) =>
      fetch(url + "/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productCode: scope + "P001",
          quantity,
          version: 1,
        }),
      });
    upstreamStatus = 503;
    assert.equal((await submit(0)).status, 400);
    assert.equal(upstreamRequests, 0);
    const unavailable = await submit();
    assert.equal(unavailable.status, 502);
    assert.deepEqual(await unavailable.json(), {
      error: "UPSTREAM_UNAVAILABLE",
    });
    assert.deepEqual(owned(), after);
    upstreamStatus = 200;
    const response = await fetch(url + "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productCode: scope + "P001",
        quantity: 1,
        version: 1,
      }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()) as any;
    assert.equal(
      (
        db
          .prepare("SELECT product_code FROM orders WHERE order_id=?")
          .get(created.orderId) as any
      ).product_code,
      scope + "P001",
    );
    // 接続先が停止した場合も、受注・在庫・versionを変更しない。
    const afterOrder = owned();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    const disconnected = await submit();
    assert.equal(disconnected.status, 502);
    assert.deepEqual(await disconnected.json(), {
      error: "UPSTREAM_UNAVAILABLE",
    });
    assert.deepEqual(owned(), afterOrder);
    // 空の全量同期でも、別の商品群・既存の受注は無効化や削除をしない。
    sync(db, { catalogVersion: 2, products: [] }, scope);
    for (const table of ["orders", "inventory", "products"])
      db.prepare(`DELETE FROM ${table} WHERE product_code GLOB ?`).run(
        scope + "*",
      );
    db.prepare("DELETE FROM sales_sync_scopes WHERE scope=?").run(scope);
    assert.deepEqual(existing(), before);
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (upstream.listening)
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
