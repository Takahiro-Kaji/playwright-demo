package learning;

import com.microsoft.playwright.*;
import com.microsoft.playwright.options.AriaRole;
import org.junit.jupiter.api.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;
import static org.junit.jupiter.api.Assertions.*;

@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SalesScenariosTest {
    static final String[] NAMES = {"ui-real", "ui-mock", "batch-real", "batch-mock", "sync-ui", "stale-order", "inconsistent-order"};
    static final Map<String,Map<String,String>> results = new LinkedHashMap<>();
    static final String RUN_ID = UUID.randomUUID().toString();
    static boolean stop;
    SalesHarness h;
    Playwright playwright;
    Browser browser;
    Page page;
    String name;
    boolean mockChanged, removed;

    @BeforeAll static void initialize() {
        for (String n : NAMES) results.put(n, new LinkedHashMap<>(Map.of("case", "NOT_RUN", "after", "NOT_RUN")));
    }
    @BeforeEach void setup(TestInfo info) {
        Assumptions.assumeFalse(stop, "previous After failed; subsequent cases stopped");
        name = NAMES[info.getTestMethod().orElseThrow().getAnnotation(Order.class).value() - 1];
    }
    void open(boolean mock, boolean ui) throws Exception {
        h = SalesHarness.open(mock);
        if (ui) {
            playwright = Playwright.create();
            browser = playwright.chromium().launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(true));
            page = browser.newPage();
            page.setDefaultTimeout(5000);
            page.setDefaultNavigationTimeout(5000);
            page.addInitScript("""
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
    interface Scenario { void run() throws Exception; }
    void run(Scenario scenario) throws Exception {
        try { scenario.run(); results.get(name).put("case", "PASS"); }
        catch (Throwable e) {
            if (e instanceof SalesHarness.StartCleanupFailure) stop = true;
            results.get(name).put("case", e instanceof Unconfirmed ? "UNCONFIRMED" : "FAIL");
            throw e;
        }
    }
    static final class Unconfirmed extends AssertionError { Unconfirmed(String message) { super(message); } }
    @AfterEach void cleanup() throws Exception {
        if (name == null) return;
        List<Throwable> errors = new ArrayList<>();
        if (h != null) errors.addAll(h.afterErrors);
        if (mockChanged) try {
            assertEquals(200, h.status(200)); assertEquals(200, h.get(h.upstream + "/catalog").statusCode());
        } catch (Throwable e) { errors.add(e); }
        if (removed) try {
            h.execute("INSERT INTO inventory VALUES('P001',5)");
            assertEquals(List.of(List.of("P001",5)), h.query("SELECT * FROM inventory WHERE product_code='P001'"));
        } catch (Throwable e) { errors.add(e); }
        try { if (browser != null) browser.close(); } catch (Throwable e) { errors.add(e); }
        try { if (playwright != null) playwright.close(); } catch (Throwable e) { errors.add(e); }
        try { if (h != null) { h.preserve = !errors.isEmpty(); h.close(); } } catch (Throwable e) { errors.add(e); }
        results.get(name).put("after", errors.isEmpty() && !stop ? "PASS" : "FAIL");
        if (!errors.isEmpty()) {
            stop = true;
            AssertionError error = new AssertionError("After failed; later scenarios stopped");
            errors.forEach(error::addSuppressed); throw error;
        }
    }
    @AfterAll static void evidence() throws Exception {
        Path path = SalesHarness.ROOT.resolve(".local/java-evidence/" + RUN_ID + "/summary.json");
        Files.createDirectories(path.getParent());
        long executed = results.values().stream().filter(x -> !x.get("case").equals("NOT_RUN")).count();
        SalesHarness.JSON.writerWithDefaultPrettyPrinter().writeValue(path.toFile(), Map.of("runId", RUN_ID, "scope", executed == 7 ? "all" : "partial", "aggregate", RunResults.aggregate(results), "cases", results));
        System.out.println("Safe evidence: " + path);
    }
    void sync() throws Exception { assertEquals(0, h.batch()); }
    void show() { page.navigate(h.app); page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("商品表示")).click(); assertThat(page.locator("[data-product-code='P001']")).isVisible(); }
    com.fasterxml.jackson.databind.JsonNode body(String path) {
        page.waitForFunction("path => window.__testBodies && window.__testBodies[path]", path);
        return SalesHarness.JSON.valueToTree(page.evaluate("path => window.__testBodies[path]",path));
    }
    Response order() { return page.waitForResponse(r -> r.url().endsWith("/api/orders"), () -> page.locator("[data-product-code='P001']").click()); }
    void expectF1() throws Exception {
        assertEquals(List.of(), CatalogCheck.differences(CatalogCheck.f1(), h.snapshot()));
    }
    @Test @Order(1) void uiReal() throws Exception { run(() -> {
        open(false,true); sync(); page.navigate(h.app);
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("外部接続確認")).click();
        assertThat(page.locator("#availability-result")).hasText("接続可能");
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("商品表示")).click();
        assertEquals(201, order().status()); assertThat(page.locator("#result")).hasText("受注しました");
        var result=body("/api/orders");
        String orderId=result.get("orderId").asText(); UUID.fromString(orderId);
        assertEquals("P001",result.get("productCode").asText()); assertEquals(1,result.get("quantity").asInt());
        assertEquals(120,result.get("unitPrice").asInt()); assertEquals("CREATED",result.get("status").asText());
        assertEquals(List.of(List.of("P001","ペン",120,1,2),List.of("P002","ノート",300,1,1)),h.query("SELECT * FROM products ORDER BY 1"));
        assertEquals(List.of(List.of("P001",4),List.of("P002",2)),h.query("SELECT * FROM inventory ORDER BY 1"));
        assertEquals(List.of(List.of(orderId,"P001",1,120,"CREATED")),h.query("SELECT * FROM orders"));
        assertEquals(List.of(List.of(1,1)),h.query("SELECT * FROM sync_state"));
    }); }
    @Test @Order(2) void uiMock() throws Exception { run(() -> {
        open(true,true); sync(); var before = h.snapshot(); mockChanged=true; assertEquals(503,h.status(503));
        assertEquals(503,h.get(h.upstream+"/catalog").statusCode()); page.navigate(h.app);
        Response r=page.waitForResponse(x->x.url().endsWith("/api/availability"), ()->page.getByRole(AriaRole.BUTTON,new Page.GetByRoleOptions().setName("外部接続確認")).click());
        assertEquals(502,r.status()); assertEquals("UPSTREAM_UNAVAILABLE",body("/api/availability").get("error").asText());
        assertThat(page.locator("#availability-result")).hasText("外部システムエラー"); assertEquals(before,h.snapshot());
    }); }
    @Test @Order(3) void batchReal() throws Exception { run(() -> {
        open(false,false); assertEquals(SalesHarness.JSON.valueToTree(SalesHarness.fixture(1)), SalesHarness.JSON.readTree(h.get(h.upstream+"/catalog").body())); sync(); expectF1();
    }); }
    @Test @Order(4) void batchMock() throws Exception { run(() -> {
        open(true,false); sync(); var before=h.snapshot(); mockChanged=true; assertEquals(503,h.status(503));
        assertEquals(503,h.get(h.upstream+"/catalog").statusCode()); assertNotEquals(0,h.batch()); assertEquals(before,h.snapshot());
    }); }
    @Test @Order(5) void syncUi() throws Exception { run(() -> { open(false,true); new SyncObservation(h,page,RUN_ID).run(); }); }
    @Test @Order(6) void staleOrder() throws Exception { run(() -> {
        open(false,true); sync(); show(); h.catalog(SalesHarness.fixture(2)); sync();
        assertEquals(List.of(List.of("P001","ペン",120,1,2),List.of("P002","ノート",300,1,1)),h.query("SELECT * FROM products ORDER BY 1"));
        assertEquals(List.of(List.of("P001",3),List.of("P002",2)),h.query("SELECT * FROM inventory ORDER BY 1"));
        assertEquals(List.of(List.of(1,2)),h.query("SELECT * FROM sync_state")); assertEquals(List.of(),h.query("SELECT * FROM orders"));
        var before=h.snapshot(); Response r=order(); assertEquals(409,r.status()); assertEquals("STALE_VERSION",body("/api/orders").get("error").asText());
        assertThat(page.locator("#result")).hasText("情報が更新されました。再表示してください"); assertEquals(before,h.snapshot());
    }); }
    @Test @Order(7) void inconsistentOrder() throws Exception { run(() -> {
        open(false,true); sync(); show(); h.execute("DELETE FROM inventory WHERE product_code='P001'"); removed=true; var before=h.snapshot();
        Response r=order(); assertEquals(409,r.status()); assertEquals("INCONSISTENT_DATA",body("/api/orders").get("error").asText());
        assertThat(page.locator("#result")).hasText("商品情報に不整合があります"); assertEquals(before,h.snapshot());
    }); }
}
