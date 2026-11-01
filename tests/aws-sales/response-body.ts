import type { Response } from "@playwright/test";

/** One deadline covers completion and body retrieval. Never retry a UI request. */
export async function readResponseJson(response: Response, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  async function bounded<T>(operation: () => Promise<T>, phase: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(operation)
          .catch(() => {
            throw Error(`HTTP_${phase}_FAILED`);
          }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`HTTP_${phase}_TIMEOUT`)),
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const failure = await bounded(() => response.finished(), "RESPONSE_FINISH");
  if (failure) throw Error("HTTP_RESPONSE_FINISH_FAILED");
  const text = await bounded(() => response.text(), "BODY_READ");
  try {
    return JSON.parse(text);
  } catch {
    // JSON parser errors may contain response data, including an SSO login page.
    throw Error("HTTP_BODY_INVALID_JSON");
  }
}
