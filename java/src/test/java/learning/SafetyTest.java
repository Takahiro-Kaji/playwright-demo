package learning;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SafetyTest {
  @Test
  void afterFailureStopsFollowingCasesAndPreservesCaseVerdict() {
    SalesScenariosTest.initialize();
    SalesScenariosTest.stop = false;
    SalesScenariosTest test = new SalesScenariosTest();
    test.name = SalesScenariosTest.NAMES[0];
    SalesScenariosTest.results.get(test.name).put("case", "FAIL");
    test.h = new SalesHarness();
    test.h.afterErrors.add(new IllegalStateException("injected restoration failure"));
    assertThrows(AssertionError.class, test::cleanup);
    assertTrue(SalesScenariosTest.stop);
    assertEquals("FAIL", SalesScenariosTest.results.get(test.name).get("case"));
    assertEquals("FAIL", SalesScenariosTest.results.get(test.name).get("after"));
    SalesScenariosTest.stop = false;
  }

  @Test
  void observerStopFailureFailsAfterStopsFollowingCasesAndRetainsDb() throws Exception {
    SalesScenariosTest.initialize();
    SalesScenariosTest.stop = false;
    SalesScenariosTest test = new SalesScenariosTest();
    test.name = SalesScenariosTest.NAMES[4];
    SalesScenariosTest.results.get(test.name).put("case", "UNCONFIRMED");
    test.h = new SalesHarness();
    Files.createDirectories(test.h.dir);
    Path sentinel = test.h.dir.resolve("recovery-marker");
    Files.writeString(sentinel, "test-owned");
    try {
      SyncObservation observer = new SyncObservation(test.h, null, "unit");
      observer.recordObserverStopFailure(
          new IllegalStateException("injected observer stop failure"));
      assertThrows(AssertionError.class, test::cleanup);
      assertTrue(SalesScenariosTest.stop);
      assertTrue(Files.exists(sentinel));
      assertEquals("UNCONFIRMED", SalesScenariosTest.results.get(test.name).get("case"));
      assertEquals("FAIL", SalesScenariosTest.results.get(test.name).get("after"));
    } finally {
      SalesScenariosTest.stop = false;
      test.h.preserve = false;
      test.h.close();
    }
  }

  @Test
  void existingPreserveFlagCannotBeClearedBySuccessfulCleanup() throws Exception {
    SalesScenariosTest.initialize();
    SalesScenariosTest.stop = false;
    SalesScenariosTest test = new SalesScenariosTest();
    test.name = SalesScenariosTest.NAMES[0];
    test.h = new SalesHarness();
    Files.createDirectories(test.h.dir);
    Path sentinel = test.h.dir.resolve("recovery-marker");
    Files.writeString(sentinel, "test-owned");
    test.h.preserve = true;
    try {
      test.cleanup();
      assertTrue(Files.exists(sentinel));
      assertTrue(test.h.preserve);
    } finally {
      test.h.preserve = false;
      test.h.close();
    }
  }

  @Test
  void browserTimingIsShrunkByCalibrationUncertainty() {
    var first = new SyncObservation.Calibration(1_000_000_000L, 1_001_000_000L, 100, 0, 0);
    var last = new SyncObservation.Calibration(1_200_000_000L, 1_201_000_000L, 300, 150, 250);
    long[] bounds = SyncObservation.conservativeBounds(first, last);
    assertTrue(bounds[0] > 1_050_000_000L);
    assertTrue(bounds[1] < 1_150_000_000L);
    assertTrue(bounds[0] < bounds[1]);
    var invalid = new SyncObservation.Calibration(1_200_000_000L, 1_201_000_000L, 300, 0, 0);
    assertArrayEquals(new long[] {0, 0}, SyncObservation.conservativeBounds(first, invalid));
    var slow = new SyncObservation.Calibration(1_000_000_000L, 1_200_000_001L, 100, 0, 0);
    assertArrayEquals(new long[] {0, 0}, SyncObservation.conservativeBounds(slow, last));
  }

  @Test
  void transitionMustBeInsideSameRequestResponseInterval() {
    SyncObservation observation = new SyncObservation(null, null, "unit");
    observation.attempts.add(Map.of("start", 100L, "response", 200L));
    observation.samples.add(Map.of("start", 90L, "end", 99L, "version", 1));
    observation.samples.add(Map.of("start", 150L, "end", 151L, "version", 2));
    assertFalse(observation.overlap());
    observation.samples.clear();
    observation.samples.add(Map.of("start", 120L, "end", 121L, "version", 1));
    observation.samples.add(Map.of("start", 150L, "end", 151L, "version", 2));
    assertTrue(observation.overlap());
  }
}
