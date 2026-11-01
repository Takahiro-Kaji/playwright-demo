import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import type { Pool, PoolConnection } from "mysql2/promise";
import { Environment } from "../environment/lifecycle.ts";
import {
  assertCondition,
  loadJournal,
  saveJournal,
  errorCodes,
  type CaseResult,
  type Journal,
} from "../environment/state.ts";
import {
  acquireTestLock,
  releaseTestLock,
  verifyTestLock,
} from "../database/test-lock.ts";
import type { BaseHarness } from "./harness.ts";

export type EnvironmentFactory = (
  file: string,
  journal: Journal,
) => Environment;

/** 準備に失敗した場合も復旧できるよう、取得済みのリソースを保持する。 */
export class HarnessSession {
  private db?: Pool;
  private lock?: PoolConnection;
  private context?: BrowserContext;
  private h?: BaseHarness;
  private env?: Environment;
  private safe = false;
  private readonly errors: unknown[] = [];

  private readonly file: string;
  private readonly create: EnvironmentFactory;
  private readonly uiSession?: { page: Page; context: BrowserContext };

  constructor(
    file: string,
    create: EnvironmentFactory,
    uiSession?: { page: Page; context: BrowserContext },
  ) {
    this.file = file;
    this.create = create;
    this.uiSession = uiSession;
  }

  initialize() {
    const j = loadJournal(this.file);
    assertCondition(
      j.phase === "prepared" && !j.blocked,
      "RUN_REQUIRES_RECOVERY",
    );
    this.env = this.create(this.file, j);
  }

  async prepare(): Promise<BaseHarness> {
    this.context = this.uiSession?.context;
    if (this.uiSession) await this.env!.target.verifyUi();
    else await this.env!.target.verifyBatch();
    this.db = await this.env!.database.pool();
    await this.env!.database.verifyOwner(this.db);
    this.lock = await acquireTestLock(this.db);
    await verifyTestLock(this.lock);
    this.safe = true;
    // 強制終了後にそのまま再実行されないよう、最初の変更前に要復旧として記録する。
    this.env!.j.blocked = true;
    saveJournal(this.file, this.env!.j);
    this.h = {
      env: this.env!,
      db: this.db,
      verdict: "unconfirmed",
      codes: [],
      afterActions: [],
    };
    await this.env!.upstream.useFixture("f1");
    await this.env!.database.reset(this.db);
    return this.h;
  }

  markFailed() {
    if (this.h && this.h.verdict === "unconfirmed" && !this.h.codes.length) {
      this.h.verdict = "failed";
      this.h.codes.push("SETUP_OR_BODY_FAILED");
    }
  }

  async finish(info: TestInfo) {
    await this.restoreAndRelease();
    if (this.env) this.recordResult(info);
    if (this.errors.length) throw Error("AWS_AFTER_FAILED");
  }

  private async restoreAndRelease() {
    // 遅れて届くUIリクエストと復元処理の競合を防ぐため、先に画面を閉じる。
    if (this.context)
      try {
        await this.context.close();
      } catch (e) {
        this.errors.push(e);
      }
    let canRestore = this.safe;
    if (this.safe && this.lock)
      try {
        await verifyTestLock(this.lock);
      } catch (e) {
        this.errors.push(e);
        canRestore = false;
      }
    if (this.h && canRestore)
      for (const action of this.h.afterActions)
        try {
          await action();
        } catch (e) {
          this.errors.push(e);
        }
    if (canRestore && this.env && this.db)
      try {
        await this.env.restore(this.db);
      } catch (e) {
        this.errors.push(e);
      }
    if (this.safe && !canRestore && this.env)
      try {
        await this.env.batches.stopAll();
      } catch (e) {
        this.errors.push(e);
      }
    if (this.lock)
      try {
        await releaseTestLock(this.lock);
      } catch (e) {
        this.errors.push(e);
      }
    if (this.db)
      try {
        await this.db.end();
      } catch (e) {
        this.errors.push(e);
      }
  }

  private recordResult(info: TestInfo) {
    const env = this.env!;
    env.j.blocked = this.safe
      ? this.errors.length > 0 || (env.j.blocked && this.h === undefined)
      : env.j.blocked;
    // restore()自身もblockedを更新するため、Job停止失敗による要復旧の状態を消さない。
    if (
      this.safe &&
      !this.errors.length &&
      this.h &&
      !this.h.codes.includes("STOP_UNCONFIRMED")
    )
      env.j.blocked = false;
    const result: CaseResult = {
      id: info.title.split(" ")[0],
      verdict: this.h?.verdict || "failed",
      after: this.errors.length ? "failed" : "confirmed",
      codes: this.h?.codes || ["SETUP_FAILED"],
      observations: this.h?.observations,
      differences: this.h?.differences,
    };
    if (this.errors.length)
      result.codes.push("AFTER_FAILED", ...this.errors.flatMap(errorCodes));
    env.j.results.push(result);
    saveJournal(this.file, env.j);
    info.annotations.push(
      { type: "business", description: result.verdict },
      { type: "after", description: result.after },
      { type: "safe-codes", description: result.codes.join(",") },
    );
  }
}
