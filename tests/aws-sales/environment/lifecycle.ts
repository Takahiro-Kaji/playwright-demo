import type { Pool } from "mysql2/promise";
import { Cluster, type Command } from "./cluster.ts";
import { assertCondition, saveJournal, type Journal } from "./state.ts";
import { manifests } from "./resources.ts";
import { Workloads } from "./workloads.ts";
import { TargetVerifier } from "./target-verifier.ts";
import { SalesDatabase } from "../database/database.ts";
import { compareMysql } from "../database/rows.ts";
import { BatchRunner } from "../old/batch/runner.ts";
import { UpstreamCatalog } from "../upstream/catalog.ts";
import { expectedFixture } from "../upstream/fixtures.ts";
import { until } from "../support/polling.ts";

/** 環境の準備・復元の順序をまとめる。個別操作は各担当に委ねる。 */
export class Environment {
  readonly file: string;
  readonly j: Journal;
  readonly cluster: Cluster;
  readonly database: SalesDatabase;
  readonly workloads: Workloads;
  readonly target: TargetVerifier;
  readonly upstream: UpstreamCatalog;
  readonly batches: BatchRunner;

  constructor(file: string, j: Journal, run?: Command) {
    this.file = file;
    this.j = j;
    this.cluster = new Cluster(j, run);
    this.database = new SalesDatabase(file, j, this.cluster);
    this.workloads = new Workloads(j, this.cluster);
    this.target = new TargetVerifier(
      j,
      this.cluster,
      this.database,
      this.workloads,
    );
    this.upstream = new UpstreamCatalog(this.cluster, this.workloads);
    this.batches = new BatchRunner(file, j, this.cluster);
  }
  save() {
    saveJournal(this.file, this.j);
  }
  async prepare() {
    assertCondition(this.j.phase === "new", "PREPARE_ALREADY_STARTED");
    await this.cluster.identity();
    const m = manifests(this.j);
    this.j.phase = "preparing";
    this.save();
    await this.cluster.create(this.file, m.namespace);
    await this.cluster.create(this.file, m.bridge);
    await until(
      async () =>
        (
          await this.cluster.verify("Pod", "sales-db-bridge")
        ).status?.conditions?.some(
          (c: any) => c.type === "Ready" && c.status === "True",
        ),
      120000,
      "BRIDGE_START_TIMEOUT",
    );
    await this.database.createSchema();
    for (const object of [
      m.secret,
      m.mockSecret,
      m.ca,
      m.catalog,
      m.upstream,
      m.upstreamService,
      m.app,
      m.service,
      m.cron,
      m.ingress,
    ])
      await this.cluster.create(this.file, object);
    await this.workloads.rollout("sales-upstream");
    await this.workloads.rollout("sales-app");
    const db = await this.database.pool();
    try {
      await this.database.verifyOwner(db);
      await this.database.reset(db);
      await this.upstream.verifyFixture("f1");
      assertCondition(
        (await this.batches.run()).outcome === "complete",
        "INITIAL_BATCH_FAILED",
      );
      assertCondition(
        (await compareMysql(db, expectedFixture("f1"))).length === 0,
        "INITIAL_DB_MISMATCH",
      );
    } finally {
      await db.end();
    }
    this.j.phase = "prepared";
    this.save();
  }
  async restore(pool: Pool) {
    const errors: unknown[] = [];
    let stopped = false;
    try {
      await this.batches.stopAll();
      stopped = true;
    } catch (e) {
      errors.push(e);
    }
    try {
      await this.upstream.useFixture("f1", "upstream");
    } catch (e) {
      errors.push(e);
    }
    // バッチの書き込み処理が動作している可能性がある間は、データを削除しない。
    if (stopped)
      try {
        await this.database.reset(pool);
      } catch (e) {
        errors.push(e);
      }
    if (!errors.length)
      try {
        assertCondition(
          (await this.batches.run()).outcome === "complete",
          "RESTORE_BATCH_FAILED",
        );
        assertCondition(
          (await compareMysql(pool, expectedFixture("f1"))).length === 0,
          "RESTORE_DB_MISMATCH",
        );
        await this.upstream.verifyFixture("f1");
      } catch (e) {
        errors.push(e);
      }
    if (errors.length) {
      this.j.blocked = true;
      this.save();
      throw new AggregateError(errors, "RESTORE_FAILED");
    }
  }
}
