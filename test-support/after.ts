/** 復元・停止処理を順に試し失敗を集める共通処理。settleAfterを読む。 */
/** Run every cleanup action and retain all failures in execution order. */
/**
 * actionsを順番に実行し、失敗しても残りを試す。各actionには先行する失敗の配列を渡す。
 * 集めた例外の配列を返す。actionの例外はここで捕捉し、呼び出し側が結果を判定する。
 */
export async function settleAfter(
  actions: Array<(prior: readonly unknown[]) => Promise<void>>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action(errors);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
