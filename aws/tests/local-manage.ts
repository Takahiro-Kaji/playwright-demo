import { manage } from "../../tests/aws-sales/manage.ts";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { newJournal, validateConfig, loadJournal, localPath, saveJournal, assertCondition } from "../../tests/aws-sales/environment/state.ts";
import { localEnvironment } from "./local-adapter.ts";
import { cleanup } from "../../tests/aws-sales/environment/cleanup.ts";
const file =
  process.env.AWS_SALES_LOCAL_JOURNAL ||
  ".local/aws-sales-qa/local-journal.json";
async function main() {
  if (process.argv[2] === "prepare") {
    assertCondition(!existsSync(file), "LOCAL_JOURNAL_EXISTS");
    const j = newJournal(
      validateConfig({
        account: "123456789012",
        region: "ap-northeast-1",
        profile: "local",
        context: "kind-sales-pr9-qa",
        cluster: "local",
        image: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sales:qa",
        dbHost: "db.region.rds.amazonaws.com",
        caFile: resolve(
          process.env.TEST_MYSQL_CA || ".local/aws-sales-qa/mysql/ca.pem",
        ),
        url: "https://local.example.test/",
        stateFile: ".local/auth/local-aws-qa.json",
        certificateArn:
          "arn:aws:acm:ap-northeast-1:123456789012:certificate/local",
        operatorCidr: "192.0.2.1/32",
        userPoolArn:
          "arn:aws:cognito-idp:ap-northeast-1:123456789012:userpool/local",
        userPoolClientId: "local",
        userPoolDomain: "local",
      }),
    );
    j.config.stateFile = `.local/auth/local-aws-qa-${j.runId}.json`;
    writeFileSync(localPath(file), JSON.stringify(j), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      localPath(j.config.stateFile),
      JSON.stringify({
        cookies: [
          {
            name: "local-qa",
            value: "local-only",
            domain: "local.example.test",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
      { mode: 0o600 },
    );
    await localEnvironment(file, j).prepare();
  } else if (process.argv[2] === "cleanup") {
    const j = loadJournal(file);
    await cleanup(localEnvironment(file, j));
  } else if (process.argv[2] === "recover") {
    await manage("recover", file, undefined, localEnvironment);
  } else throw Error("LOCAL_ACTION_INVALID");
}
main()
  .then(() => console.log("LOCAL_OPERATION_CONFIRMED"))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
