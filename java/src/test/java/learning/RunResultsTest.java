package learning;

import static org.junit.jupiter.api.Assertions.*;

import java.util.*;
import org.junit.jupiter.api.Test;

class RunResultsTest {
  private Map<String, Map<String, String>> passingCases() {
    Map<String, Map<String, String>> cases = new LinkedHashMap<>();
    for (String name : SalesScenariosTest.NAMES)
      cases.put(name, new HashMap<>(Map.of("case", "PASS", "after", "PASS")));
    return cases;
  }

  @Test
  void onlyTheSevenKnownCasesCanAllPass() {
    var cases = passingCases();
    assertEquals("all", RunResults.scope(cases));
    assertEquals("PASS", RunResults.business(cases));
    assertEquals("PASS", RunResults.after(cases));
    assertEquals("PASS", RunResults.aggregate(cases));
    var saved = cases.remove("ui-real");
    cases.put("unknown", saved);
    assertEquals("partial", RunResults.scope(cases));
    assertEquals("PARTIAL", RunResults.aggregate(cases));
    cases.remove("unknown");
    assertEquals("partial", RunResults.scope(cases));
    assertNotEquals("PASS", RunResults.aggregate(cases));
  }

  @Test
  void failureIsNeverHiddenByAnUnrunCase() {
    var cases = passingCases();
    cases.get("ui-real").put("case", "NOT_RUN");
    cases.get("ui-real").put("after", "NOT_RUN");
    cases.get("ui-mock").put("case", "FAIL");
    assertEquals("partial", RunResults.scope(cases));
    assertEquals("FAIL", RunResults.business(cases));
    assertEquals("PARTIAL", RunResults.after(cases));
    assertEquals("FAIL", RunResults.aggregate(cases));
    cases.get("ui-mock").put("case", "PASS");
    cases.get("ui-mock").put("after", "FAIL");
    assertEquals("PARTIAL", RunResults.business(cases));
    assertEquals("FAIL", RunResults.after(cases));
    assertEquals("FAIL", RunResults.aggregate(cases));
  }

  @Test
  void unconfirmedAndPartialNeverBecomePass() {
    var cases = passingCases();
    cases.get("ui-real").put("case", "NOT_RUN");
    assertEquals("PARTIAL", RunResults.aggregate(cases));
    cases.get("ui-real").put("case", "UNCONFIRMED");
    assertEquals("all", RunResults.scope(cases));
    assertEquals("UNCONFIRMED", RunResults.business(cases));
    assertEquals("PASS", RunResults.after(cases));
    assertEquals("UNCONFIRMED", RunResults.aggregate(cases));
  }
}
