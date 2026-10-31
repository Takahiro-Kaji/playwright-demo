package dev.playrightdemo.scenarios.ui;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.microsoft.playwright.*;
import dev.playrightdemo.targets.demoitems.LocalUiEnvironment;
import dev.playrightdemo.targets.demoitems.ExternalEnvironment;
import dev.playrightdemo.foundation.UiEnvironment;
import dev.playrightdemo.foundation.UiEnvironment.Target;
import dev.playrightdemo.foundation.RunSummary;
import dev.playrightdemo.foundation.CleanupBudget;
import java.net.http.*;
import java.nio.file.Path;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.sql.Connection;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

/** Shared Given / When / Then / After orchestration for the demo-items UI cases. */
public class UiCaseRunner {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final AtomicBoolean SAFE_TO_START = new AtomicBoolean(true);
    static void requireSafeEnvironment() { if(!SAFE_TO_START.get()) throw new IllegalStateException("Previous case failed or restoration was not confirmed"); }
    @BeforeEach void checkStopGuard() { requireSafeEnvironment(); }
    private String token;
    private final HttpClient http = HttpClient.newHttpClient();
    private CleanupBudget cleanupBudget;
    private ScheduledExecutorService cleanupWatchdog;
    private final AtomicBoolean cleanupExpired = new AtomicBoolean(false);
    private void beginCleanup(Thread owner, UiEnvironment environment) {
        if(cleanupBudget!=null) return;
        Duration limit="1".equals(System.getenv("UI_VERIFY_CLEANUP_TIMEOUT")) ? Duration.ofMillis(1) : Duration.ofSeconds(60);
        cleanupBudget=new CleanupBudget(limit); environment.setCleanupDeadlineNanos(cleanupBudget.deadlineNanos());
        cleanupWatchdog=Executors.newSingleThreadScheduledExecutor(r -> { Thread t=new Thread(r,"cleanup-deadline"); t.setDaemon(true); return t; });
        cleanupWatchdog.schedule(() -> { cleanupExpired.set(true); owner.interrupt(); },limit.toNanos(),TimeUnit.NANOSECONDS);
    }
    private Duration operationTimeout() throws java.io.IOException { return cleanupBudget==null ? Duration.ofSeconds(5) : cleanupBudget.remaining(Duration.ofSeconds(5)); }

    private JsonNode control(Target mock, Integer desired, JsonNode expected) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(mock.admin().resolve("/admin/status")).timeout(operationTimeout()).header("Authorization", "Bearer " + token);
        if (desired == null) b.GET();
        else b.header("Content-Type", "application/json").PUT(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(Map.of("status", desired, "expected", expected))));
        var response = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) throw new IllegalStateException("Mock control HTTP " + response.statusCode());
        JsonNode state;
        try { state=JSON.readTree(response.body()); } catch(com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException("Invalid mock state JSON"); }
        if(state==null || !state.isObject() || !state.path("region").isTextual() || !mock.region().equals(state.path("region").textValue()) || !state.path("status").isIntegralNumber() || !state.path("status").canConvertToInt() || state.path("status").intValue()<200 || state.path("status").intValue()>599 || !state.path("version").isIntegralNumber() || !state.path("version").canConvertToLong() || state.path("version").longValue()<0 || !state.path("instanceId").isTextual() || state.path("instanceId").textValue().isBlank()) throw new IllegalStateException("Invalid mock state");
        var safe=JSON.createObjectNode(); safe.put("region",state.path("region").textValue()); safe.put("status",state.path("status").intValue()); safe.put("version",state.path("version").longValue()); safe.put("instanceId",state.path("instanceId").textValue()); return safe;
    }
    private void probe(Target mock, JsonNode state) throws Exception {
        var r = http.send(HttpRequest.newBuilder(mock.business().resolve("/status")).timeout(operationTimeout()).build(), HttpResponse.BodyHandlers.discarding());
        assertEquals(state.path("status").asInt(), r.statusCode());
        assertEquals(state.path("region").asText(), r.headers().firstValue("x-mock-region").orElse(null));
        assertEquals(state.path("version").asText(), r.headers().firstValue("x-mock-version").orElse(null));
        assertEquals(state.path("instanceId").asText(), r.headers().firstValue("x-mock-instance-id").orElse(null));
    }
    void execute(int externalStatus, String route, boolean noSwitch) throws Exception { execute(externalStatus,route,noSwitch,null); }
    void execute(int externalStatus, String route, boolean noSwitch, UiEnvironment supplied) throws Exception {
        var summary = new LinkedHashMap<String,Object>();
        RunSummary run = new RunSummary(Path.of(".local", "runs"));
        summary.put("runId", run.runId().toString()); summary.put("caseId", route + " / " + (noSwitch ? "no-switch" : externalStatus == 200 ? "both-ok" : "both-unavailable"));
        boolean external=supplied!=null ? !supplied.disposable() : "external".equals(System.getProperty("ui.profile","local"));
        Map<String,String> hashes = new LinkedHashMap<>();
        try { for(String file:List.of("src/test/java/dev/playrightdemo/scenarios/ui/UiCaseRunner.java", "src/test/java/dev/playrightdemo/scenarios/ui/LocalUiTest.java", "src/test/java/dev/playrightdemo/foundation/LocalMysql.java", "src/test/java/dev/playrightdemo/targets/demoitems/LocalUiEnvironment.java", "src/test/java/dev/playrightdemo/foundation/UiEnvironment.java", "src/test/java/dev/playrightdemo/foundation/CleanupBudget.java", "src/main/java/dev/playrightdemo/process/OwnedProcesses.java", "build.gradle", "src/main/java/dev/playrightdemo/demo/app/DemoApp.java", "src/main/java/dev/playrightdemo/demo/statusmock/StatusMock.java")) hashes.put(file, sha256(Files.readAllBytes(Path.of(file)))); }
        catch(Exception e) { SAFE_TO_START.set(false); throw e; }
        if(external) try { hashes.put("src/test/java/dev/playrightdemo/targets/demoitems/ExternalEnvironment.java",sha256(Files.readAllBytes(Path.of("src/test/java/dev/playrightdemo/targets/demoitems/ExternalEnvironment.java")))); } catch(Exception e) { SAFE_TO_START.set(false); throw e; }
        summary.put("sourceHashes", hashes);
        summary.put("inputHash", sha256((route + "/" + externalStatus + "/no-switch=" + noSwitch + "/initial-b=" + ("1".equals(System.getenv("UI_VERIFY_WRONG_FEEDBACK")) ? 429 : 200) + "/wrong-feedback=" + System.getenv("UI_VERIFY_WRONG_FEEDBACK") + "/wrong-status=" + System.getenv("UI_VERIFY_DB_STATUS") + "/timeout=" + System.getenv("UI_VERIFY_TIMEOUT") + "/restore-fail=" + System.getenv("UI_VERIFY_RESTORE_FAIL") + "/attach-fail=" + System.getenv("UI_VERIFY_ATTACH") + "/cleanup-timeout=" + System.getenv("UI_VERIFY_CLEANUP_TIMEOUT")).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        summary.put("business", "unconfirmed"); summary.put("restore", "unconfirmed"); summary.put("environmentCleanup", "unconfirmed");
        Throwable failure = null;
        boolean environmentClean = false;
        if(external && ("1".equals(System.getenv("UI_VERIFY_WRONG_FEEDBACK")) || "1".equals(System.getenv("UI_VERIFY_DB_STATUS")) || "1".equals(System.getenv("UI_VERIFY_RESTORE_FAIL")) || "1".equals(System.getenv("UI_VERIFY_TIMEOUT")) || "1".equals(System.getenv("UI_VERIFY_CLEANUP_TIMEOUT")) || "1".equals(System.getenv("UI_VERIFY_ATTACH")))) { SAFE_TO_START.set(false); throw new IllegalArgumentException("Fault injection is local only"); }
        try (UiEnvironment environment = supplied!=null ? supplied : external ? ExternalEnvironment.fromEnvironment() : LocalUiEnvironment.start("1".equals(System.getenv("UI_VERIFY_DB_STATUS")) && externalStatus==200,"1".equals(System.getenv("UI_VERIFY_WRONG_FEEDBACK")))) {
            token=environment.mockToken(); summary.put("environment",external?"external":"local-disposable"); summary.put("environmentIdentity",environment.metadata());
            List<Target> mocks = environment.targets(); List<JsonNode> original = new ArrayList<>(), configured = new ArrayList<>();
            List<Object> restoreEvidence = new ArrayList<>(); summary.put("mockRestore", restoreEvidence);
            boolean ownershipUnknown = false;
            Playwright pw=null; Browser browser=null;
            Thread owner=Thread.currentThread(); AtomicBoolean timedOut=new AtomicBoolean(false);
            ScheduledExecutorService watchdog=Executors.newSingleThreadScheduledExecutor(r -> { Thread t=new Thread(r,"ui-deadline"); t.setDaemon(true); return t; });
            watchdog.schedule(() -> { timedOut.set(true); owner.interrupt(); }, 30, TimeUnit.SECONDS);
            try {
                for (var m : mocks) original.add(control(m,null,null));
                summary.put("initialMockStatuses",original.stream().map(n -> n.path("status").asInt()).toList());
                for (int i=0;i<mocks.size();i++) { ownershipUnknown = !noSwitch; JsonNode state = noSwitch ? original.get(i) : control(mocks.get(i),externalStatus,original.get(i)); configured.add(state); ownershipUnknown = false; assertEquals(externalStatus,state.path("status").asInt()); probe(mocks.get(i),state); }
                String key = "it-" + UUID.randomUUID();
                summary.put("keyHash",sha256(key.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                if(external) { summary.put("generatedKey",key); summary.put("rowDisposition","unconfirmed-requires-inspection"); }
                int beforeCount=count(environment,key); summary.put("dbBeforeCount",beforeCount); assertEquals(0,beforeCount);
                pw = Playwright.create(); browser = pw.chromium().launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(true));
                    Page page = browser.newPage();
                    if ("1".equals(System.getenv("UI_VERIFY_TIMEOUT"))) { watchdog.schedule(() -> { timedOut.set(true); owner.interrupt(); }, 1, TimeUnit.SECONDS); Thread.sleep(10000); }
                    if ("1".equals(System.getenv("UI_VERIFY_WRONG_FEEDBACK")) && externalStatus == 503) {
                        page.route("**/form.js", intercepted -> {
                            var originalResponse = intercepted.fetch();
                            String body = originalResponse.text();
                            if (!body.contains("外部システムエラー")) throw new IllegalStateException("Fault target not found");
                            intercepted.fulfill(new Route.FulfillOptions().setResponse(originalResponse).setBody(body.replace("外部システムエラー", "注入した誤表示")));
                        });
                    }
                    page.navigate((route.equals("random") ? environment.baseUri() : mocks.get(route.equals("b") ? 1 : 0).app()).resolve("/items/new").toString());
                    page.getByTestId("item-test-key").fill(key);
                    Response response = page.waitForResponse(r -> r.url().endsWith("/api/items") && r.request().method().equals("POST"), () -> page.getByTestId("item-create").click());
                    summary.put("http", Map.of("status",response.status(), "externalStatus",Objects.toString(response.headerValue("x-external-status"),"missing"), "appRegion",Objects.toString(response.headerValue("x-app-region"),"missing"), "mockRegion",Objects.toString(response.headerValue("x-mock-region"),"missing")));
                    assertEquals(externalStatus == 200 ? 201 : 502, response.status());
                    assertEquals(String.valueOf(externalStatus), response.headerValue("x-external-status"));
                    String actualRegion=response.headerValue("x-app-region");
                    int routedIndex=route.equals("random") ? (mocks.get(0).region().equals(actualRegion) ? 0 : mocks.get(1).region().equals(actualRegion) ? 1 : -1) : route.equals("b") ? 1 : 0;
                    assertTrue(routedIndex>=0); assertEquals(mocks.get(routedIndex).region(),actualRegion);
                    if(external && route.equals("random")) assertEquals(actualRegion,response.headerValue("x-routed-region"));
                    JsonNode routedMock=configured.get(routedIndex);
                    assertEquals(routedMock.path("instanceId").asText(), response.headerValue("x-mock-instance-id"));
                    summary.put("mockIdentityMatches",Objects.equals(routedMock.path("instanceId").asText(),response.headerValue("x-mock-instance-id")) && Objects.equals(routedMock.path("version").asText(),response.headerValue("x-mock-version")) && Objects.equals(routedMock.path("region").asText(),response.headerValue("x-mock-region")));
                    assertEquals(routedMock.path("version").asText(), response.headerValue("x-mock-version"));
                    assertEquals(routedMock.path("region").asText(), response.headerValue("x-mock-region"));
                    Locator feedback = page.getByTestId("item-create-result");
                    com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(feedback).isVisible();
                    com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(feedback).hasAttribute("data-state",externalStatus == 200 ? "success" : "error");
                    summary.put("ui",Map.of("visible",feedback.isVisible(),"textMatches",feedback.innerText().equals(externalStatus == 200 ? "作成しました" : "外部システムエラー"),"roleMatches",Objects.equals(feedback.getAttribute("role"),externalStatus == 200 ? "status" : "alert"),"stateMatches",Objects.equals(feedback.getAttribute("data-state"),externalStatus == 200 ? "success" : "error"),"liveMatches",Objects.equals(feedback.getAttribute("aria-live"),externalStatus == 200 ? "polite" : "assertive")));
                    com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(feedback).hasText(externalStatus == 200 ? "作成しました" : "外部システムエラー");
                    assertEquals(externalStatus == 200 ? "status" : "alert", feedback.getAttribute("role"));
                    assertEquals(externalStatus == 200 ? "success" : "error", feedback.getAttribute("data-state"));
                    assertEquals(externalStatus == 200 ? "polite" : "assertive", feedback.getAttribute("aria-live"));
                if (externalStatus == 200) {
                    try (Connection c=environment.dataSource().getConnection(); var s=c.prepareStatement("SELECT test_key, status, CAST(id AS CHAR) FROM items WHERE test_key=?")) { c.setReadOnly(true); s.setQueryTimeout(5); s.setString(1,key); try (var rows=s.executeQuery()) { assertTrue(rows.next()); String actualKey=rows.getString(1), actualStatus=rows.getString(2), id=rows.getString(3); summary.put("dbAfter",Map.of("firstRowPresent",true,"keyMatches",key.equals(actualKey),"statusMatches","CREATED".equals(actualStatus),"idIsDecimalString",id!=null && id.matches("[0-9]+"))); assertEquals(key,actualKey); assertEquals("CREATED",actualStatus); assertNotNull(id); assertTrue(id.matches("[0-9]+")); assertFalse(rows.next()); summary.put("dbAfterCount",1); if(external) summary.put("rowDisposition","retained-requires-cleanup"); } }
                } else { long start=System.nanoTime(), until=start+Duration.ofSeconds(2).toNanos(); summary.put("dbRequestedObservationMillis",2000); summary.put("dbObservationCompleted",false); try { do { int count=count(environment,key); summary.put("dbAfterCount",count); assertEquals(0,count); Thread.sleep(250); } while(System.nanoTime()<until); summary.put("dbObservationCompleted",true); if(external) summary.put("rowDisposition","not-created-observed"); } finally { summary.put("dbObservationElapsedMillis",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)); } }
                for(int i=0;i<mocks.size();i++) assertEquals(configured.get(i),control(mocks.get(i),null,null));
                if(timedOut.get()) throw new IllegalStateException("UI deadline exceeded");
                summary.put("business","PASS");
            } catch (Throwable e) { summary.put("business","FAIL"); summary.put("failureKind",timedOut.get()?"timeout":"assertion-or-execution"); failure=e; }
            finally {
                watchdog.shutdownNow(); boolean interrupted=Thread.interrupted();
                beginCleanup(owner,environment);
                boolean browserClosed=true;
                try { if(browser!=null) browser.close(); } catch(Throwable e) { browserClosed=false; if(failure==null) failure=e; else failure.addSuppressed(e); }
                try { if(pw!=null) pw.close(); } catch(Throwable e) { browserClosed=false; if(failure==null) failure=e; else failure.addSuppressed(e); }
                summary.put("browserCleanup",browserClosed?"completed":"failed");
                if("1".equals(System.getenv("UI_VERIFY_CLEANUP_TIMEOUT"))) try { Thread.sleep(10); } catch(InterruptedException e) { interrupted=true; }
                if("1".equals(System.getenv("UI_VERIFY_RESTORE_FAIL")) && !configured.isEmpty()) {
                    try { control(mocks.get(0),429,configured.get(0)); }
                    catch(Throwable e) { if(failure==null) failure=e; else failure.addSuppressed(e); }
                }
                boolean restored = !ownershipUnknown;
                for(int i=0;i<configured.size();i++) try { JsonNode after=noSwitch ? control(mocks.get(i),null,null) : control(mocks.get(i),original.get(i).path("status").asInt(),configured.get(i)); probe(mocks.get(i),after); restoreEvidence.add(Map.of("original",original.get(i),"configured",configured.get(i),"restored",after,"probe","passed")); } catch(Throwable e) {
                    restored=false;
                    try { JsonNode current=control(mocks.get(i),null,null); probe(mocks.get(i),current); restoreEvidence.add(Map.of("original",original.get(i),"configured",configured.get(i),"current",current,"outcome","failed","probe","passed")); }
                    catch(Throwable observation) { e.addSuppressed(observation); restoreEvidence.add(Map.of("outcome","failed","probe","unconfirmed")); }
                    if(failure==null) failure=e; else failure.addSuppressed(e);
                }
                summary.put("restore", restored ? "completed" : "failed");
                if(!restored || failure!=null) SAFE_TO_START.set(false);
                if(interrupted && !timedOut.get()) Thread.currentThread().interrupt();
            }
            environmentClean = true;
        } catch(Throwable e) { if(failure==null) failure=e; else failure.addSuppressed(e); environmentClean = false; }
        if(cleanupWatchdog!=null) cleanupWatchdog.shutdownNow();
        if(cleanupExpired.get()) Thread.interrupted();
        if(cleanupBudget!=null) {
            summary.put("cleanupBudget",cleanupBudget.expired() || cleanupExpired.get()?"exceeded":"within-budget");
            if(cleanupBudget.expired() || cleanupExpired.get()) { var e=new java.io.IOException("Cleanup budget exceeded"); if(failure==null) failure=e; else failure.addSuppressed(e); }
        }
        summary.put("environmentCleanup", environmentClean ? "completed" : "failed");
        summary.put("attachment", "not-requested");
        if("1".equals(System.getenv("UI_VERIFY_ATTACH"))) {
            try {
                Path attachmentDirectory=Path.of(".local", "runs", run.runId().toString(), "attachments");
                Files.createDirectories(attachmentDirectory);
                Files.writeString(attachmentDirectory, "non-secret evidence");
            } catch (Exception e) { summary.put("attachment","failed"); if(failure==null) failure=e; else failure.addSuppressed(e); }
        }
        if(failure!=null || !environmentClean) SAFE_TO_START.set(false);
        summary.put("runner", failure == null ? "passed" : "failed");
        try { run.save(summary); } catch(Throwable e) { if(failure==null) failure=e; else failure.addSuppressed(e); }
        if(failure!=null) { SAFE_TO_START.set(false); throw new AssertionError("Local UI run failed; runId=" + run.runId(),failure); }
    }
    private static String sha256(byte[] value) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
    private static int count(UiEnvironment environment,String key) throws Exception { try(Connection c=environment.dataSource().getConnection(); var s=c.prepareStatement("SELECT COUNT(*) FROM items WHERE test_key=?")) { c.setReadOnly(true); s.setQueryTimeout(5); s.setString(1,key); try(var r=s.executeQuery()) { r.next(); return r.getInt(1); } } }
}
