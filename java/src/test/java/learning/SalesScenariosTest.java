package learning;

import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;
import static org.junit.jupiter.api.Assertions.*;

import com.microsoft.playwright.*;
import com.microsoft.playwright.options.AriaRole;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;

// 復元に失敗したら後続を止められるよう、ケースを番号順に実行する。
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SalesScenariosTest {
  static final String[] NAMES = {
    "ui-real", "ui-mock", "batch-real", "batch-mock", "sync-ui", "stale-order", "inconsistent-order"
  };
  static final Map<String, Map<String, String>> results = new LinkedHashMap<>();
  static final String RUN_ID = UUID.randomUUID().toString();
  static boolean stop;
  SalesHarness h;
  Playwright playwright;
  Browser browser;
  Page page;
  String name;
  boolean mockChanged, removed;
  Integer originalMockStatus;

  // 実行されなかったケースも NOT_RUN として残し、部分実行を総合 PASS にしない。
  @BeforeAll
  static void initialize() {
    for (String n : NAMES)
      results.put(n, new LinkedHashMap<>(Map.of("case", "NOT_RUN", "after", "NOT_RUN")));
  }

  @BeforeEach
  void setup(TestInfo info) {
    Assumptions.assumeFalse(stop, "previous After failed; subsequent cases stopped");
    name = NAMES[info.getTestMethod().orElseThrow().getAnnotation(Order.class).value() - 1];
  }

  void open(boolean mock, boolean ui) throws Exception {
    h = SalesHarness.open(mock);
    if (ui) {
      playwright = Playwright.create();
      browser =
          playwright
              .chromium()
              .launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(true));
      page = browser.newPage();
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(5000);
      // アプリの fetch 応答を複製して検証する。応答内容を変更せず、証跡にも本文を保存しない。
      page.addInitScript(
          """
          window.__testBodies = {};
          const originalFetch = window.fetch;
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            const key = new URL(response.url).pathname;
            response.clone().json().then(body => { window.__testBodies[key] = body; });
            return response;
          };
          """);
    }
  }

  interface Scenario {
    void run() throws Exception;
  }

  // 試験本体の判定は After の成否とは別に記録する。
  void run(Scenario scenario) throws Exception {
    try {
      scenario.run();
      results.get(name).put("case", "PASS");
    } catch (Throwable e) {
      if (e instanceof SalesHarness.StartCleanupFailure) stop = true;
      results.get(name).put("case", e instanceof Unconfirmed ? "UNCONFIRMED" : "FAIL");
      throw e;
    }
  }

  static final class Unconfirmed extends AssertionError {
    Unconfirmed(String message) {
      super(message);
    }
  }

  // 復元が失敗しても他の停止処理を続け、失敗はまとめて報告する。
  @AfterEach
  void cleanup() throws Exception {
    if (name == null) return;
    List<Throwable> errors = new ArrayList<>();
    if (h != null) errors.addAll(h.afterErrors);
    if (mockChanged)
      try {
        assertEquals(originalMockStatus.intValue(), h.status(originalMockStatus));
        assertEquals(originalMockStatus.intValue(), h.status());
        assertEquals(originalMockStatus.intValue(), h.get(h.upstream + "/catalog").statusCode());
      } catch (Throwable e) {
        errors.add(e);
      }
    if (removed)
      try {
        h.execute("INSERT INTO inventory VALUES('P001',5)");
        assertEquals(
            List.of(List.of("P001", 5)),
            h.query("SELECT * FROM inventory WHERE product_code='P001'"));
      } catch (Throwable e) {
        errors.add(e);
      }
    try {
      if (browser != null) browser.close();
    } catch (Throwable e) {
      errors.add(e);
    }
    try {
      if (playwright != null) playwright.close();
    } catch (Throwable e) {
      errors.add(e);
    }
    try {
      if (h != null) {
        h.preserve = h.preserve || !errors.isEmpty();
        h.close();
      }
    } catch (Throwable e) {
      errors.add(e);
    }
    results.get(name).put("after", errors.isEmpty() && !stop ? "PASS" : "FAIL");
    if (!errors.isEmpty()) {
      stop = true;
      AssertionError error = new AssertionError("After failed; later scenarios stopped");
      errors.forEach(error::addSuppressed);
      throw error;
    }
  }

  // runId ごとに保存し、既存の試験結果を上書きしない。
  @AfterAll
  static void evidence() throws Exception {
    Path path = SalesHarness.ROOT.resolve(".local/java-evidence/" + RUN_ID + "/summary.json");
    Files.createDirectories(path.getParent());
    SalesHarness.JSON
        .writerWithDefaultPrettyPrinter()
        .writeValue(
            path.toFile(),
            Map.of(
                "runId",
                RUN_ID,
                "scope",
                RunResults.scope(results),
                "business",
                RunResults.business(results),
                "after",
                RunResults.after(results),
                "aggregate",
                RunResults.aggregate(results),
                "allPass",
                "PASS".equals(RunResults.aggregate(results)),
                "cases",
                results));
    System.out.println("Safe evidence: " + path);
  }

  // 変更前の値を取得し、PUT が失敗しても復元を試みるよう先にフラグを立てる。
  void makeMockUnavailable() throws Exception {
    originalMockStatus = h.status();
    mockChanged = true;
    assertEquals(503, h.status(503));
  }

  /** 固定 fixture の同期バッチを実行し、正常終了を確認する。引数・戻り値はない。 */
  void sync() throws Exception {
    assertEquals(0, h.batch());
  }

  /** 商品画面を開いて商品表示が完了するまで待つ。引数・戻り値はない。 */
  void show() {
    page.navigate(h.app);
    page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("商品表示")).click();
    assertThat(page.locator("[data-product-code='P001']")).isVisible();
  }

  /** path の API 応答本文を待ち、検証可能な JSON として返す。 */
  com.fasterxml.jackson.databind.JsonNode body(String path) {
    page.waitForFunction("path => window.__testBodies && window.__testBodies[path]", path);
    return SalesHarness.JSON.valueToTree(page.evaluate("path => window.__testBodies[path]", path));
  }

  // 操作より先に応答待ちを登録し、速い HTTP 応答を取り逃さない。
  /** 引数なしで P001 を注文し、その HTTP 応答を返す。 */
  Response order() {
    return page.waitForResponse(
        r -> r.url().endsWith("/api/orders"),
        () -> page.locator("[data-product-code='P001']").click());
  }

  /** データセット1 の事前固定期待値を4表の snapshot と比較する。引数・戻り値はない。 */
  void expectDataset1() throws Exception {
    assertEquals(List.of(), CatalogCheck.differences(CatalogCheck.dataset1(), h.snapshot()));
  }

  // ケース1: データセット1 を同期 → 画面から受注 → 受注結果と4表を照合。
  @Test
  @DisplayName("画面から外部接続を確認して正常に受注できる")
  @Order(1)
  void uiReal() throws Exception {
    run(
        () -> {
          // Given: 試験専用のプロセスと DB を準備する。
          open(false, true);
          sync();
          page.navigate(h.app);
          // When: 接続を確認し、画面から P001 を受注する。
          page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("外部接続確認")).click();
          assertThat(page.locator("#availability-result")).hasText("接続可能");
          page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("商品表示")).click();
          assertEquals(201, order().status());
          assertThat(page.locator("#result")).hasText("受注しました");
          // Then: 固定期待値と受注 ID の関連を使い、応答と全4表を検証する。
          var result = body("/api/orders");
          String orderId = result.get("orderId").asText();
          UUID parsedOrderId = UUID.fromString(orderId);
          assertEquals(orderId, parsedOrderId.toString());
          assertEquals(4, parsedOrderId.version());
          assertEquals(2, parsedOrderId.variant());
          assertEquals("P001", result.get("productCode").asText());
          assertEquals(1, result.get("quantity").asInt());
          assertEquals(120, result.get("unitPrice").asInt());
          assertEquals("CREATED", result.get("status").asText());
          assertEquals(
              List.of(List.of("P001", "ペン", 120, 1, 2), List.of("P002", "ノート", 300, 1, 1)),
              h.query("SELECT * FROM products ORDER BY 1"));
          assertEquals(
              List.of(List.of("P001", 4), List.of("P002", 2)),
              h.query("SELECT * FROM inventory ORDER BY 1"));
          assertEquals(
              List.of(List.of(orderId, "P001", 1, 120, "CREATED")),
              h.query("SELECT * FROM orders"));
          assertEquals(List.of(List.of(1, 1)), h.query("SELECT * FROM sync_state"));
          // After: 共通の cleanup で復元・停止を確認する。
        });
  }

  // ケース2: 商品表示後に上流を503に設定 → 受注 → 502表示と4表の不変を確認。After で復元する。
  @Test
  @DisplayName("外部IF障害時は受注に失敗し関連データが変わらない")
  @Order(2)
  void uiMock() throws Exception {
    run(
        () -> {
          // Given: 試験専用のプロセスと DB を準備する。
          open(true, true);
          sync();
          show();
          var before = h.snapshot();
          makeMockUnavailable();
          assertEquals(503, h.get(h.upstream + "/catalog").statusCode());
          // When: 表示済みP001の受注ボタンを押す。
          Response r = order();
          // Then: 502、エラー表示、事前 snapshot と4表の不変を確認する。
          assertEquals(502, r.status());
          assertEquals("UPSTREAM_UNAVAILABLE", body("/api/orders").get("error").asText());
          assertThat(page.locator("#result")).hasText("外部システムエラー");
          assertEquals(before, h.snapshot());
          // After: 共通の cleanup で復元・停止を確認する。
        });
  }

  // ケース3: 実 HTTP の データセット1 を取得 → バッチ実行 → 独立した固定期待値と4表を比較。
  @Test
  @DisplayName("同期バッチの結果が全件の固定期待値と一致する")
  @Order(3)
  void batchReal() throws Exception {
    run(
        () -> {
          // Given: 試験専用のプロセスと DB を準備する。
          open(false, false);
          assertEquals(
              SalesHarness.JSON.valueToTree(SalesHarness.fixture(1)),
              SalesHarness.JSON.readTree(h.get(h.upstream + "/catalog").body()));
          // When: 実 HTTP を使う同期バッチを実行する。
          sync();
          // Then: 終了コードだけでなく独立した固定期待値で全表を比較する。
          expectDataset1();
          // After: 共通の cleanup で復元・停止を確認する。
        });
  }

  // ケース4: 上流503 → バッチ失敗 → 失敗前後の4表が同じことを確認。
  @Test
  @DisplayName("外部IF障害時は同期に失敗し対象データが変わらない")
  @Order(4)
  void batchMock() throws Exception {
    run(
        () -> {
          // Given: 試験専用のプロセスと DB を準備する。
          open(true, false);
          sync();
          var before = h.snapshot();
          makeMockUnavailable();
          assertEquals(503, h.get(h.upstream + "/catalog").statusCode());
          // When: 上流が503の間にバッチを起動する。
          assertNotEquals(0, h.batch());
          // Then: 更新がなく4表が変更前のままであることを確認する。
          assertEquals(before, h.snapshot());
          // After: 共通の cleanup で復元・停止を確認する。
        });
  }

  // ケース5: 3000件で同期と画面参照を並行し、実際に重なりを観測できたか判定する。
  @Test
  @DisplayName("同期中の商品表示が旧状態または新状態で一貫する")
  @Order(5)
  void syncUi() throws Exception {
    run(
        () -> {
          // Given: 試験専用のプロセスと DB を準備する。
          open(false, true);
          // When / Then: 同期と表示を並行し、実観測の重なりと全件を検証する。
          // 観測できなければ UNCONFIRMED とし、全体を成功にしない。
          new SyncObservation(h, page, RUN_ID).run();
          // After: 共通の cleanup で復元・停止を確認する。
        });
  }

  // ケース6: 旧版を表示後に新版へ同期 → 旧画面で受注 → 409 と4表不変。
  @Test
  @DisplayName("古い表示からの受注を拒否する")
  @Order(6)
  void staleOrder() throws Exception {
    run(
        () -> {
          // Given: 試験専用のプロセスと DB を準備する。
          open(false, true);
          sync();
          show();
          h.catalog(SalesHarness.fixture(2));
          sync();
          assertEquals(
              List.of(List.of("P001", "ペン", 120, 1, 2), List.of("P002", "ノート", 300, 1, 1)),
              h.query("SELECT * FROM products ORDER BY 1"));
          assertEquals(
              List.of(List.of("P001", 3), List.of("P002", 2)),
              h.query("SELECT * FROM inventory ORDER BY 1"));
          assertEquals(List.of(List.of(1, 2)), h.query("SELECT * FROM sync_state"));
          assertEquals(List.of(), h.query("SELECT * FROM orders"));
          var before = h.snapshot();
          // When: 同期前の画面から受注する。
          Response r = order();
          // Then: STALE_VERSION と、受注・在庫を含む4表の不変を確認する。
          assertEquals(409, r.status());
          assertEquals("STALE_VERSION", body("/api/orders").get("error").asText());
          assertThat(page.locator("#result")).hasText("情報が更新されました。再表示してください");
          assertEquals(before, h.snapshot());
          // After: 共通の cleanup で復元・停止を確認する。
        });
  }

  // ケース7: 在庫行を意図的に欠落 → 受注 → 409 と4表不変。After で在庫行を戻す。
  @Test
  @DisplayName("商品と在庫が不整合な場合は受注を拒否する")
  @Order(7)
  void inconsistentOrder() throws Exception {
    run(
        () -> {
          // Given: 試験専用のプロセスと DB を準備する。
          open(false, true);
          sync();
          show();
          h.execute("DELETE FROM inventory WHERE product_code='P001'");
          removed = true;
          var before = h.snapshot();
          // When: 商品と在庫の関連が欠けたまま受注する。
          Response r = order();
          // Then: INCONSISTENT_DATA と4表の不変を確認する。
          assertEquals(409, r.status());
          assertEquals("INCONSISTENT_DATA", body("/api/orders").get("error").asText());
          assertThat(page.locator("#result")).hasText("商品情報に不整合があります");
          assertEquals(before, h.snapshot());
          // After: 共通の cleanup で復元・停止を確認する。
        });
  }
}
