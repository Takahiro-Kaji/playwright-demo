/** Run every cleanup action and retain all failures in execution order. */
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
