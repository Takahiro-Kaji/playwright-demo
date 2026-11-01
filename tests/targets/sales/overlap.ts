/** 同期とUI参照の重なりを時刻とDB観測で判定する。型、hasObservedOverlapの順に読む。 */
export type Observation = { start: number; end: number; version: number };
export type Attempt = {
  start: number | null;
  response: number | null;
  display: number | null;
  status: number | null;
  valid: boolean | null;
};
/** Only a complete successful UI attempt containing two complete ordered DB observations proves overlap. */
/**
 * 同一の正常なUI参照中にDBの1→2を順に観測できたか返す。attemptsは参照、samplesはSELECTの区間。
 * 成立ならtrue、証拠不足ならfalse。通常は例外を送出しない。
 */
export function hasObservedOverlap(
  attempts: Attempt[],
  samples: Observation[],
): boolean {
  return attempts.some((a) => {
    if (
      a.start === null ||
      a.response === null ||
      a.display === null ||
      a.start > a.response ||
      a.response > a.display ||
      a.status !== 200 ||
      a.valid !== true
    )
      return false;
    return samples.some(
      (before, i) =>
        before.version === 1 &&
        before.start >= a.start! &&
        before.start <= before.end &&
        samples
          .slice(i + 1)
          .some(
            (after) =>
              after.version === 2 &&
              after.start >= before.end &&
              after.start <= after.end &&
              after.end <= a.response!,
          ),
    );
  });
}
