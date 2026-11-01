package learning;

import com.fasterxml.jackson.databind.JsonNode;
import com.microsoft.playwright.*;
import com.microsoft.playwright.options.AriaRole;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.jupiter.api.Assertions.*;

/** Playwright は呼び出し元スレッドのみ、別スレッドでは JDBC のみを使用する。 */
final class SyncObservation {
    static final int COUNT=3000, MAX_ATTEMPTS=20, MAX_SAMPLES=10000;
    final SalesHarness h; final Page page; final String runId;
    final List<Map<String,Object>> samples=Collections.synchronizedList(new ArrayList<>());
    final List<Map<String,Object>> attempts=new ArrayList<>();
    final List<String> errors=new ArrayList<>();
    final AtomicBoolean observing=new AtomicBoolean(true);
    final AtomicReference<Throwable> observerFailure=new AtomicReference<>();
    volatile long requestStart, responseEnd;
    SyncObservation(SalesHarness h, Page page, String runId) { this.h=h; this.page=page; this.runId=runId; }
    // 同期中ケース専用の固定データ。商品コード・価格・数量を実測値から作らない。
    static Map<String,Object> fixture(int version) {
        List<Map<String,Object>> products=new ArrayList<>();
        for(int i=1;i<=COUNT;i++) products.add(SalesHarness.product(String.format("S%04d",i),String.format("学習商品%04d",i),100+i,version==1?5:3));
        return Map.of("catalogVersion",version,"products",products);
    }
    // 別スレッドでは JDBC だけを使い、各問い合わせの開始と終了を記録する。
    void observe() {
        try (Connection c=h.connection(); Statement s=c.createStatement()) {
            while(observing.get() && samples.size()<MAX_SAMPLES) {
                long start=System.nanoTime();
                try(ResultSet rs=s.executeQuery("SELECT catalog_version FROM sync_state WHERE id=1")) {
                    if (!rs.next()) throw new SQLException("missing sync_state");
                    int version=rs.getInt(1); long end=System.nanoTime();
                    samples.add(Map.of("start",start,"end",end,"version",version));
                }
                Thread.sleep(1);
            }
        } catch(Throwable e) { observerFailure.set(e); }
    }
    // 同じ HTTP 要求から応答までの内側で、版1から版2への変化が観測された場合だけ成立。
    boolean overlap() {
        synchronized(samples) {
            for(var a:attempts) {
                long start=(long)a.get("start"), end=(long)a.get("response");
                if (start<=0 || end<=start || Boolean.FALSE.equals(a.get("valid"))) continue;
                boolean old=false;
                for(var s:samples) {
                    long ss=(long)s.get("start"), se=(long)s.get("end"); int version=(int)s.get("version");
                    if(ss>=start && se<=end && version==1) old=true;
                    if(old && ss>=start && se<=end && version==2) return true;
                }
            }
        }
        return false;
    }
    // 一部の代表行だけではなく、応答と画面の全3000行・操作可能状態を照合する。
    void verifyResponse(JsonNode rows) {
        assertEquals(COUNT,rows.size());
        int version=rows.get(0).get("version").asInt(); assertTrue(version==1 || version==2);
        for(int i=1;i<=COUNT;i++) {
            JsonNode row=rows.get(i-1);
            assertEquals(String.format("S%04d",i),row.get("productCode").asText());
            assertEquals(String.format("学習商品%04d",i),row.get("name").asText());
            assertEquals(100+i,row.get("price").asInt()); assertEquals(version==1?5:3,row.get("quantity").asInt());
            assertEquals(version,row.get("version").asInt());
        }
        com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(page.locator("#products > div").first())
            .hasText(String.format("学習商品%04d %d円 在庫%d受注",1,101,version==1?5:3));
        List<String> texts=page.locator("#products > div").allTextContents();
        assertEquals(COUNT,texts.size());
        for(int i=1;i<=COUNT;i++) assertEquals(String.format("学習商品%04d %d円 在庫%d受注",i,100+i,version==1?5:3),texts.get(i-1));
        assertTrue(page.getByRole(AriaRole.BUTTON,new Page.GetByRoleOptions().setName("商品表示")).isEnabled());
        assertEquals(COUNT, page.locator("#products button:enabled").count());
    }
    // バッチの終了コードとは別に、同期後の4表を固定期待値で検証する。
    void verifyFinal() throws Exception {
        var products=h.query("SELECT * FROM products ORDER BY product_code");
        var inventory=h.query("SELECT * FROM inventory ORDER BY product_code");
        assertEquals(COUNT,products.size()); assertEquals(COUNT,inventory.size());
        for(int i=1;i<=COUNT;i++) {
            String code=String.format("S%04d",i);
            assertEquals(List.of(code,String.format("学習商品%04d",i),100+i,1,2),products.get(i-1));
            assertEquals(List.of(code,3),inventory.get(i-1));
        }
        assertEquals(List.of(List.of(1,2)),h.query("SELECT * FROM sync_state")); assertEquals(List.of(),h.query("SELECT * FROM orders"));
    }
    void run() throws Exception {
        ExecutorService executor=Executors.newSingleThreadExecutor(); Future<?> observer=null; Process batch=null;
        boolean established=false; Integer batchCode=null;
        try {
            h.catalog(fixture(1)); assertEquals(0,h.batch()); page.navigate(h.app); h.catalog(fixture(2));
            page.onPageError(errors::add);
            page.onRequest(r -> { if(r.url().endsWith("/api/products")) requestStart=System.nanoTime(); });
            page.onResponse(r -> { if(r.status()>=500) errors.add("HTTP "+r.status()); if(r.url().endsWith("/api/products")) responseEnd=System.nanoTime(); });
            // Playwright はこのスレッドで操作し、DB の観測だけを executor に任せる。
            observer=executor.submit(this::observe); batch=h.batchStart(); long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(12);
            for(int i=0;i<MAX_ATTEMPTS && System.nanoTime()<deadline && (batch.isAlive() || i==0);i++) {
                requestStart=0; responseEnd=0;
                int status=0; boolean valid=false;
                try {
                    page.evaluate("() => delete window.__testBodies['/api/products']");
                    Response response=page.waitForResponse(r->r.url().endsWith("/api/products"),
                        ()->page.getByRole(AriaRole.BUTTON,new Page.GetByRoleOptions().setName("商品表示")).click());
                    status=response.status(); assertEquals(200,status);
                    page.waitForFunction("() => window.__testBodies['/api/products']");
                    JsonNode rows=SalesHarness.JSON.valueToTree(page.evaluate("() => window.__testBodies['/api/products']")).get("products");
                    com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(page.locator("#products > div")).hasCount(COUNT);
                    verifyResponse(rows); valid=true;
                } finally {
                    attempts.add(Map.of("start",requestStart,"response",responseEnd,"display",System.nanoTime(),"status",status,"valid",valid));
                }
            }
            long remaining=Math.max(0,deadline-System.nanoTime());
            if(!batch.waitFor(remaining,TimeUnit.NANOSECONDS)) throw new SalesScenariosTest.Unconfirmed("batch did not finish within observation deadline");
            batchCode=batch.exitValue(); assertEquals(0,batchCode); observing.set(false); observer.get(5,TimeUnit.SECONDS);
            if(observerFailure.get()!=null) throw new AssertionError("JDBC observer failed",observerFailure.get());
            assertFalse(attempts.isEmpty()); assertTrue(errors.isEmpty()); verifyFinal(); established=overlap();
            // 観測できなかったことは成功でも仕様違反の確定でもなく、未確認として非ゼロにする。
            if(!established) throw new SalesScenariosTest.Unconfirmed("version transition was not observed within any HTTP request-response interval");
        } finally {
            observing.set(false); executor.shutdownNow();
            try {
                if(!executor.awaitTermination(5,TimeUnit.SECONDS)) throw new IllegalStateException("observer stop unconfirmed");
            } catch (Throwable error) { h.preserve=true; h.afterErrors.add(error); }
            try {
                Path path=SalesHarness.ROOT.resolve(".local/java-evidence/"+runId+"/overlap.json"); Files.createDirectories(path.getParent());
                SalesHarness.JSON.writerWithDefaultPrettyPrinter().writeValue(path.toFile(),Map.of("fixtureCount",COUNT,"maxAttempts",MAX_ATTEMPTS,"maxSamples",MAX_SAMPLES,"clock","System.nanoTime", "attempts",attempts,"samples",samples,"batchCode",batchCode==null?-1:batchCode,"established",established));
            } catch (Throwable error) { h.preserve=true; h.afterErrors.add(error); }
        }
    }
}
