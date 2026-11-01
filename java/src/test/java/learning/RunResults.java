package learning;

import java.util.Map;
import java.util.Set;

/** 実行範囲、試験本体、後処理を独立に集計し、最後に総合判定を作る。 */
final class RunResults {
  static String scope(Map<String, Map<String, String>> cases) {
    if (!cases.keySet().equals(Set.of(SalesScenariosTest.NAMES))) return "partial";
    return cases.values().stream().allMatch(c -> !"NOT_RUN".equals(c.get("case")))
        ? "all"
        : "partial";
  }

  static String business(Map<String, Map<String, String>> cases) {
    if (cases.values().stream().anyMatch(c -> "FAIL".equals(c.get("case")))) return "FAIL";
    if (cases.values().stream().anyMatch(c -> "UNCONFIRMED".equals(c.get("case"))))
      return "UNCONFIRMED";
    if ("partial".equals(scope(cases))) return "PARTIAL";
    return cases.values().stream().allMatch(c -> "PASS".equals(c.get("case"))) ? "PASS" : "FAIL";
  }

  static String after(Map<String, Map<String, String>> cases) {
    if (cases.values().stream().anyMatch(c -> "FAIL".equals(c.get("after")))) return "FAIL";
    if ("partial".equals(scope(cases))
        || cases.values().stream().anyMatch(c -> "NOT_RUN".equals(c.get("after"))))
      return "PARTIAL";
    return cases.values().stream().allMatch(c -> "PASS".equals(c.get("after"))) ? "PASS" : "FAIL";
  }

  static String aggregate(Map<String, Map<String, String>> cases) {
    String business = business(cases);
    String after = after(cases);
    if ("FAIL".equals(business) || "FAIL".equals(after)) return "FAIL";
    if ("UNCONFIRMED".equals(business)) return "UNCONFIRMED";
    if ("PARTIAL".equals(business) || "PARTIAL".equals(after)) return "PARTIAL";
    return "PASS";
  }
}
