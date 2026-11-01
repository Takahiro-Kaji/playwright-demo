import { spawn } from "node:child_process";
import {
  loadJournal,
  exclusive,
  requireThat as check,
  errorCodes,
  saveJournal,
} from "./environment.ts";
import { Environment } from "./lifecycle.ts";
import { cleanup } from "./cleanup.ts";

/** Prepared run + manual authentication are required. The run is cleaned even on failure. */
export async function runSuite(file: string, args: string[]) {
  const j = loadJournal(file);
  check(j.phase === "prepared" && !j.blocked, "RUN_REQUIRES_RECOVERY");
  check(
    process.env.AWS_SALES_ADMIN_USER && process.env.AWS_SALES_ADMIN_PASSWORD,
    "ADMIN_CREDENTIALS_REQUIRED_FOR_FINAL_CLEANUP",
  );
  check(
    args.length === 0 ||
      (args.length === 2 &&
        args[0] === "--grep" &&
        /^(UI-0[12]|BATCH-0[12]|CROSS-0[123])$/.test(args[1])),
    "CASE_SELECTION_INVALID",
  );
  // Do not keep a file lock while the test worker acquires the same run lock.
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
      latest.lastErrors = errorCodes(e);
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
