import { resolve, sep } from "node:path";

/** 認証状態の保存先と秘密を含まないHTTPS URLを検証する。 */
export function validateAuthConfig(state: string, target: string) {
  const root = resolve(".local/auth") + sep;
  const path = resolve(state);
  if (!path.startsWith(root) || !path.endsWith(".json"))
    throw Error("AUTH_PATH_REQUIRED");
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw Error("HTTPS_TARGET_REQUIRED");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("HTTPS_TARGET_REQUIRED");
  return { path, url: url.toString() };
}
