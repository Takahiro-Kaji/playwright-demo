import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  newJournal,
  validateConfig,
  type Config,
} from "../../aws-sales/environment.ts";
export function fixture() {
  mkdirSync(".local/aws-sales-qa", { recursive: true });
  const dir = mkdtempSync(resolve(".local/aws-sales-qa/run-"));
  const ca = join(dir, "ca.pem");
  writeFileSync(ca, "test");
  const config: Config = {
    account: "123456789012",
    region: "ap-northeast-1",
    profile: "test",
    context: "test",
    cluster: "test",
    image: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/test:v1",
    dbHost: "db.region.rds.amazonaws.com",
    caFile: ca,
    url: "https://test.example.com/",
    stateFile: ".local/auth/test.json",
    certificateArn: "arn:aws:acm:ap-northeast-1:123456789012:certificate/test",
    operatorCidr: "192.0.2.1/32",
    userPoolArn:
      "arn:aws:cognito-idp:ap-northeast-1:123456789012:userpool/test",
    userPoolClientId: "abc",
    userPoolDomain: "test",
  };
  const j = newJournal(validateConfig(config));
  return {
    dir,
    j,
    file: join(dir, "journal.json"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
