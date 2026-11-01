export const pause = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
export async function until(
  fn: () => Promise<boolean>,
  ms: number,
  code: string,
  poll = 500,
) {
  const deadline = performance.now() + ms;
  do {
    if (await fn()) return;
    if (performance.now() >= deadline) break;
    await pause(Math.min(poll, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw Error(code);
}
