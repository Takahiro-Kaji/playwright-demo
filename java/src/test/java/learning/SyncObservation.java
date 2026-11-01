package learning;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.microsoft.playwright.*;
import com.microsoft.playwright.options.AriaRole;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Playwright は呼び出し元スレッドのみ、別スレッドでは JDBC のみを使用する。 */
final class SyncObservation {
  static final int COUNT = 3000, MAX_ATTEMPTS = 20, MAX_SAMPLES = 10000;
  final SalesHarness h;
  final Page page;
  final String runId;
  final List<Map<String, Object>> samples = Collections.synchronizedList(new ArrayList<>());
  final List<Map<String, Object>> attempts = new ArrayList<>();
  final List<String> errors = new ArrayList<>();
  final AtomicBoolean observing = new AtomicBoolean(true);
  final AtomicReference<Throwable> observerFailure = new AtomicReference<>();
  // 時刻の丸め、計測遅延、異なる単調時計の小さなずれを各側5ms分保守的に縮める。
  static final long TIMING_MARGIN_NS = 5_000_000L;
  static final long MAX_CALIBRATION_NS = 100_000_000L;

  record Calibration(
      long before, long after, double browserNowMs, double requestMs, double responseMs) {}

  Calibration calibrate() {
    long before = System.nanoTime();
    @SuppressWarnings("unchecked")
    Map<String, Object> timing =
        (Map<String, Object>)
            page.evaluate(
                """
                () => {
                  const entry = performance.getEntriesByType('resource')
                    .filter(e => new URL(e.name).pathname === '/api/products').at(-1);
                  return { now: performance.now(), request: entry?.requestStart ?? 0,
                           response: entry?.responseStart ?? 0 };
                }
                """);
    long after = System.nanoTime();
    return new Calibration(
        before,
        after,
        ((Number) timing.get("now")).doubleValue(),
        ((Number) timing.get("request")).doubleValue(),
        ((Number) timing.get("response")).doubleValue());
  }

  // 2回の較正の往復時間と差を考慮して、証明に使える区間を狭める。
  static long[] conservativeBounds(Calibration first, Calibration last) {
    if (first.after() - first.before() > MAX_CALIBRATION_NS
        || last.after() - last.before() > MAX_CALIBRATION_NS
        || last.requestMs() <= 0
        || last.responseMs() <= last.requestMs()) return new long[] {0, 0};
    long firstBrowser = Math.round(first.browserNowMs() * 1_000_000);
    long lastBrowser = Math.round(last.browserNowMs() * 1_000_000);
    long minOffset = Math.min(first.before() - firstBrowser, last.before() - lastBrowser);
    long maxOffset = Math.max(first.after() - firstBrowser, last.after() - lastBrowser);
    long width = maxOffset - minOffset;
    if (width < 0 || width > MAX_CALIBRATION_NS) return new long[] {0, 0};
    long margin = TIMING_MARGIN_NS + width;
    long start = Math.round(last.requestMs() * 1_000_000) + maxOffset + margin;
    long response = Math.round(last.responseMs() * 1_000_000) + minOffset - margin;
    return start < response ? new long[] {start, response} : new long[] {0, 0};
  }

  SyncObservation(SalesHarness h, Page page, String runId) {
    this.h = h;
    this.page = page;
    this.runId = runId;
  }

  // 同期中ケース専用の固定データ。商品コード・価格・数量を実測値から作らない。
  static Map<String, Object> fixture(int version) {
    List<Map<String, Object>> products = new ArrayList<>();
    for (int i = 1; i <= COUNT; i++)
      products.add(
          SalesHarness.product(
              String.format("S%04d", i),
              String.format("学習商品%04d", i),
              100 + i,
              version == 1 ? 5 : 3));
    return Map.of("catalogVersion", version, "products", products);
  }

  // 別スレッドでは JDBC だけを使い、各問い合わせの開始と終了を記録する。
  void observe() {
    try (Connection c = h.connection();
        Statement s = c.createStatement()) {
      while (observing.get() && samples.size() < MAX_SAMPLES) {
        long start = System.nanoTime();
        try (ResultSet rs = s.executeQuery("SELECT catalog_version FROM sync_state WHERE id=1")) {
          if (!rs.next()) throw new SQLException("missing sync_state");
          int version = rs.getInt(1);
          long end = System.nanoTime();
          samples.add(Map.of("start", start, "end", end, "version", version));
        }
        Thread.sleep(1);
      }
    } catch (Throwable e) {
      observerFailure.set(e);
    }
  }

  // 同じ HTTP 要求から応答までの内側で、版1から版2への変化が観測された場合だけ成立。
  boolean overlap() {
    synchronized (samples) {
      for (var a : attempts) {
        long start = (long) a.get("start"), end = (long) a.get("response");
        if (start <= 0 || end <= start || Boolean.FALSE.equals(a.get("valid"))) continue;
        boolean old = false;
        for (var s : samples) {
          long ss = (long) s.get("start"), se = (long) s.get("end");
          int version = (int) s.get("version");
          if (ss >= start && se <= end && version == 1) old = true;
          if (old && ss >= start && se <= end && version == 2) return true;
        }
      }
    }
    return false;
  }

  // 一部の代表行だけではなく、応答と画面の全3000行・操作可能状態を照合する。
  void verifyResponse(JsonNode rows) {
    assertEquals(COUNT, rows.size());
    int version = rows.get(0).get("version").asInt();
    assertTrue(version == 1 || version == 2);
    for (int i = 1; i <= COUNT; i++) {
      JsonNode row = rows.get(i - 1);
      assertEquals(String.format("S%04d", i), row.get("productCode").asText());
      assertEquals(String.format("学習商品%04d", i), row.get("name").asText());
      assertEquals(100 + i, row.get("price").asInt());
      assertEquals(version == 1 ? 5 : 3, row.get("quantity").asInt());
      assertEquals(version, row.get("version").asInt());
    }
    com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(
            page.locator("#products > div").first())
        .hasText(String.format("学習商品%04d %d円 在庫%d受注", 1, 101, version == 1 ? 5 : 3));
    List<String> texts = page.locator("#products > div").allTextContents();
    assertEquals(COUNT, texts.size());
    for (int i = 1; i <= COUNT; i++)
      assertEquals(
          String.format("学習商品%04d %d円 在庫%d受注", i, 100 + i, version == 1 ? 5 : 3), texts.get(i - 1));
    assertTrue(
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("商品表示")).isEnabled());
    assertEquals(COUNT, page.locator("#products button:enabled").count());
  }

  // バッチの終了コードとは別に、同期後の4表を固定期待値で検証する。
  void verifyFinal() throws Exception {
    var products = h.query("SELECT * FROM products ORDER BY product_code");
    var inventory = h.query("SELECT * FROM inventory ORDER BY product_code");
    assertEquals(COUNT, products.size());
    assertEquals(COUNT, inventory.size());
    for (int i = 1; i <= COUNT; i++) {
      String code = String.format("S%04d", i);
      assertEquals(List.of(code, String.format("学習商品%04d", i), 100 + i, 1, 2), products.get(i - 1));
      assertEquals(List.of(code, 3), inventory.get(i - 1));
    }
    assertEquals(List.of(List.of(1, 2)), h.query("SELECT * FROM sync_state"));
    assertEquals(List.of(), h.query("SELECT * FROM orders"));
  }

  // 停止を確認できない場合、DB を残し、共通 After に失敗を渡す。
  void recordObserverStopFailure(Throwable error) {
    h.preserve = true;
    h.afterErrors.add(error);
  }

  void run() throws Exception {
    ExecutorService executor = Executors.newSingleThreadExecutor();
    Future<?> observer = null;
    Process batch = null;
    boolean established = false;
    boolean candidateOverlap = false;
    // 2回の較正だけでは、その間のブラウザー時計と JVM 時計のドリフト上限を証明できない。
    boolean clockBoundProven = false;
    Integer batchCode = null;
    try {
      h.catalog(fixture(1));
      assertEquals(0, h.batch());
      page.navigate(h.app);
      h.catalog(fixture(2));
      page.onPageError(errors::add);
      page.onResponse(
          r -> {
            if (r.status() >= 500) errors.add("HTTP " + r.status());
          });
      // Playwright はこのスレッドで操作し、DB の観測だけを executor に任せる。
      observer = executor.submit(this::observe);
      batch = h.batchStart();
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12);
      for (int i = 0;
          i < MAX_ATTEMPTS && System.nanoTime() < deadline && (batch.isAlive() || i == 0);
          i++) {
        long[] bounds = {0, 0};
        Calibration first = null;
        Calibration last = null;
        int status = 0;
        boolean valid = false;
        try {
          page.evaluate(
              "() => { delete window.__testBodies['/api/products'];"
                  + " performance.clearResourceTimings(); }");
          first = calibrate();
          Response response =
              page.waitForResponse(
                  r -> r.url().endsWith("/api/products"),
                  () ->
                      page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("商品表示"))
                          .click());
          status = response.status();
          assertEquals(200, status);
          page.waitForFunction("() => window.__testBodies['/api/products']");
          JsonNode rows =
              SalesHarness.JSON
                  .valueToTree(page.evaluate("() => window.__testBodies['/api/products']"))
                  .get("products");
          com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(
                  page.locator("#products > div"))
              .hasCount(COUNT);
          verifyResponse(rows);
          last = calibrate();
          bounds = conservativeBounds(first, last);
          valid = true;
        } finally {
          Map<String, Object> attempt = new LinkedHashMap<>();
          attempt.put("start", bounds[0]);
          attempt.put("response", bounds[1]);
          attempt.put("firstCalibrationBefore", first == null ? 0 : first.before());
          attempt.put("firstCalibrationAfter", first == null ? 0 : first.after());
          attempt.put("firstBrowserNowMs", first == null ? 0 : first.browserNowMs());
          attempt.put("lastCalibrationBefore", last == null ? 0 : last.before());
          attempt.put("lastCalibrationAfter", last == null ? 0 : last.after());
          attempt.put("lastBrowserNowMs", last == null ? 0 : last.browserNowMs());
          attempt.put("browserRequestMs", last == null ? 0 : last.requestMs());
          attempt.put("browserResponseMs", last == null ? 0 : last.responseMs());
          attempt.put("display", System.nanoTime());
          attempt.put("status", status);
          attempt.put("valid", valid);
          attempts.add(attempt);
        }
      }
      long remaining = Math.max(0, deadline - System.nanoTime());
      if (!batch.waitFor(remaining, TimeUnit.NANOSECONDS))
        throw new SalesScenariosTest.Unconfirmed(
            "batch did not finish within observation deadline");
      batchCode = batch.exitValue();
      assertEquals(0, batchCode);
      observing.set(false);
      observer.get(5, TimeUnit.SECONDS);
      if (observerFailure.get() != null)
        throw new AssertionError("JDBC observer failed", observerFailure.get());
      assertFalse(attempts.isEmpty());
      assertTrue(errors.isEmpty());
      verifyFinal();
      candidateOverlap = overlap();
      established = candidateOverlap && clockBoundProven;
      // 実観測が候補になっても、時計間の誤差上限を証明できなければ PASS にしない。
      if (!established)
        throw new SalesScenariosTest.Unconfirmed(
            candidateOverlap
                ? "clock error bound is not proven"
                : "version transition was not observed within the conservative HTTP interval");
    } finally {
      observing.set(false);
      executor.shutdownNow();
      try {
        if (!executor.awaitTermination(5, TimeUnit.SECONDS))
          throw new IllegalStateException("observer stop unconfirmed");
      } catch (Throwable error) {
        recordObserverStopFailure(error);
      }
      try {
        Path path = SalesHarness.ROOT.resolve(".local/java-evidence/" + runId + "/overlap.json");
        Files.createDirectories(path.getParent());
        SalesHarness.JSON
            .writerWithDefaultPrettyPrinter()
            .writeValue(
                path.toFile(),
                Map.of(
                    "fixtureCount",
                    COUNT,
                    "maxAttempts",
                    MAX_ATTEMPTS,
                    "maxSamples",
                    MAX_SAMPLES,
                    "clock",
                    "browser resource requestStart/responseStart mapped to System.nanoTime with two"
                        + " bracketing calibrations and conservative margin",
                    "attempts",
                    attempts,
                    "samples",
                    samples,
                    "batchCode",
                    batchCode == null ? -1 : batchCode,
                    "candidateOverlap",
                    candidateOverlap,
                    "clockBoundProven",
                    clockBoundProven,
                    "established",
                    established));
      } catch (Throwable error) {
        h.preserve = true;
        h.afterErrors.add(error);
      }
    }
  }
}
