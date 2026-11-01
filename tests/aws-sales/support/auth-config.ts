import { authSettings } from "../../../test-support/auth/fixture.ts";

/** AWSテストには、明示的なHTTPSアプリ接続先とSSO認証状態が必要。 */
export function awsSsoConfig(env: NodeJS.ProcessEnv = process.env) {
  const settings = authSettings(env);
  if (!settings) throw Error("AWS_SSO_AUTH_REQUIRED");
  const start = new URL(settings.target);
  const success = new URL(settings.expected);
  if (
    start.pathname !== "/" ||
    success.href !== start.href ||
    settings.selector !== "#refresh"
  )
    throw Error("AWS_SSO_EXPECTED_CONFIG_REQUIRED");
  const domain = env.AWS_SSO_COGNITO_DOMAIN;
  if (
    !domain ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(
      domain,
    )
  )
    throw Error("AWS_SSO_COGNITO_DOMAIN_REQUIRED");
  return { ...settings, cognitoDomain: domain };
}
