/** Local QA only. AWS identity/ALB/Cognito are NOT verified by this adapter. */
import { Environment } from "../../tests/aws-sales/lifecycle.ts";
import {
  command,
  requireThat as check,
  type Journal,
} from "../../tests/aws-sales/environment.ts";
export function localEnvironment(file: string, j: Journal) {
  check(j.config.context === "kind-sales-pr9-qa", "LOCAL_CONTEXT_REQUIRED");
  const env = new Environment(file, j, async (binary, args, input, timeout) => {
    check(
      binary === "kubectl" && args.includes("kind-sales-pr9-qa"),
      "LOCAL_KUBECTL_ONLY",
    );
    return command(binary, args, input, timeout);
  });
  env.cluster.identity = async () => {
    const config = JSON.parse(
      await command("kubectl", [
        "--context",
        j.config.context,
        "config",
        "view",
        "--minify",
        "-o",
        "json",
      ]),
    );
    check(
      new URL(config.clusters[0].cluster.server).hostname === "127.0.0.1",
      "LOCAL_SERVER_REQUIRED",
    );
    return {};
  };
  const create = env.cluster.create.bind(env.cluster);
  env.cluster.create = async (path, object) => {
    if (object.kind !== "Ingress") await create(path, object);
  };
  env.cluster.aws = async (service, operation) => {
    check(service === "elbv2", "LOCAL_AWS_DISABLED");
    if (operation === "describe-load-balancers") return { LoadBalancers: [] };
    if (operation === "describe-target-groups") return { TargetGroups: [] };
    throw Error("LOCAL_AWS_DISABLED");
  };
  env.verifyTarget = async () => env.verifyBatchTarget();
  return env;
}
