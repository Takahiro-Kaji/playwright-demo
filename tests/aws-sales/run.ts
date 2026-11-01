import { spawn } from "node:child_process";
import {
  loadJournal,
  exclusive,
  assertCondition,
  errorCodes,
  saveJournal,
} from "./environment/state.ts";
import { Environment } from "./environment/lifecycle.ts";
import { cleanup } from "./environment/cleanup.ts";

/** 準備済みの実行環境と手動認証が必要。失敗時も実行環境を後片付けする。 */
export async function runSuite(file: string, args: string[]) {
  const j = loadJournal(file);
  assertCondition(
    j.phase === "prepared" && !j.blocked,
    "RUN_REQUIRES_RECOVERY",
  );
  assertCondition(
    process.env.AWS_SALES_ADMIN_USER && process.env.AWS_SALES_ADMIN_PASSWORD,
    "ADMIN_CREDENTIALS_REQUIRED_FOR_FINAL_CLEANUP",
  );
  assertCondition(
    args.length === 0 ||
      (args.length === 2 &&
        args[0] === "--grep" &&
        /^(UI-0[12]|BATCH-0[12]|CROSS-0[123])$/.test(args[1])),
    "CASE_SELECTION_INVALID",
  );
  // テストワーカーが同じ実行環境のロックを取得する間は、ファイルロックを保持しない。
  const child = spawn(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "-c",
      "tests/aws-sales/aws-sales.config.ts",
      ...args,
    ],
    {
      env: { ...process.env, AWS_SALES_JOURNAL: file },
      stdio: "inherit",
      shell: false,
    },
  );
  const interrupt = () => {
    child.kill("SIGINT");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let code = 1;
  let primary: unknown;
  try {
    code = await new Promise<number>((ok, no) => {
      child.on("error", () => no(Error("TEST_PROCESS_START_FAILED")));
      child.on("close", (c) => ok(c ?? 1));
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const record = loadJournal(file);
    record.execution = {
      exitCode: code,
      cleanup: "pending",
      codes: primary ? errorCodes(primary) : [],
    };
    saveJournal(file, record);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    const unlock = exclusive(file);
    try {
      const latest = loadJournal(file);
      await cleanup(new Environment(file, latest));
      latest.execution!.cleanup = "confirmed";
      saveJournal(file, latest);
    } catch (e) {
      const latest = loadJournal(file);
      latest.blocked = true;
      latest.lastErrors = [
        ...new Set([...(latest.lastErrors || []), ...errorCodes(e)]),
      ];
      latest.execution!.cleanup = "failed";
      latest.execution!.codes.push(...errorCodes(e));
      saveJournal(file, latest);
      throw Error("FINAL_CLEANUP_FAILED");
    } finally {
      unlock();
    }
  }
  return code;
}
if (import.meta.main)
  runSuite(process.argv[2], process.argv.slice(3))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(errorCodes(e).join(","));
      process.exitCode = 1;
    });
