package dev.playrightdemo.scenarios.crossfeature;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.microsoft.playwright.*;
import dev.playrightdemo.demo.referenceview.ReferenceView;
import dev.playrightdemo.foundation.RunSummary;
import dev.playrightdemo.targets.reference.ReferenceEnvironment;
import dev.playrightdemo.targets.reference.ReferenceRows;
import dev.playrightdemo.targets.reference.ReferenceRows.*;
import java.net.http.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

@Tag("local-cross")
class LocalCrossTest {
    record Sample(double start, double end, long count) {}
    private static double now() { return System.currentTimeMillis(); }
    @Test void uiReadsDuringCommittedChanges() throws Exception {
        RunSummary run=new RunSummary(Path.of(".local","runs")); Map<String,Object> summary=new LinkedHashMap<>();
        summary.put("runId",run.runId().toString()); summary.put("caseId","cross/read-during-sync"); summary.put("overlap","unconfirmed"); summary.put("business","unconfirmed"); summary.put("environmentCleanup","unconfirmed");
        Throwable failure=null;
        try { execute(summary); } catch(Throwable e) {
            failure=e;
            if("unconfirmed".equals(summary.get("business")) && !"PASS".equals(summary.get("finalComparison"))) summary.put("business","FAIL");
        }
        summary.put("runner",failure==null?"passed":"failed");
        try { run.save(summary); } catch(Throwable e) { if(failure==null) failure=e; else failure.addSuppressed(e); }
        if(failure!=null) throw new AssertionError("Cross run failed; runId="+run.runId(),failure);
    }
    private void execute(Map<String,Object> summary) throws Exception {
        List<Object> records=new ArrayList<>(); List<Parent> parents=new ArrayList<>(); List<Child> children=new ArrayList<>();
        for(int i=0;i<15000;i++) { String p=Long.toString(100000L+i), c=Long.toString(200000L+i), label="Parent-"+i; records.add(Map.of("id",p,"destination","east","label",label,"note","", "children",List.of(Map.of("id",c,"destination","east","value","v")))); parents.add(new Parent(p,"east",label,"")); children.add(new Child(c,p,"east","v")); }
        Snapshot expected=new Snapshot(parents,children); Map<String,String> hashes=new LinkedHashMap<>();
        for(String file:List.of("src/test/java/dev/playrightdemo/scenarios/crossfeature/LocalCrossTest.java","src/test/java/dev/playrightdemo/targets/reference/ReferenceEnvironment.java","src/test/java/dev/playrightdemo/targets/reference/ReferenceRows.java","src/main/java/dev/playrightdemo/demo/referencesync/ReferenceSync.java","src/main/java/dev/playrightdemo/demo/referenceview/ReferenceView.java")) hashes.put(file,HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(Path.of(file)))));
        summary.put("sourceHashes",hashes);
        Path creds=Files.createTempFile("play-right-cross-", ".json", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        try(ReferenceEnvironment env=ReferenceEnvironment.start(creds,records,summary); ReferenceView view=new ReferenceView(env.mysql.dataSource()).start("127.0.0.1",0)) {
            try(var c=env.mysql.dataSource().getConnection(); var s=c.createStatement()) { s.execute("CREATE TABLE parents (id BIGINT UNSIGNED NOT NULL, destination VARCHAR(20) NOT NULL, label VARCHAR(64) NOT NULL, note VARCHAR(64) NULL)"); s.execute("CREATE TABLE children (id BIGINT UNSIGNED NOT NULL, parent_id BIGINT UNSIGNED NOT NULL, destination VARCHAR(20) NOT NULL, value VARCHAR(64) NULL)"); }
            var capture=HttpClient.newHttpClient().send(HttpRequest.newBuilder(env.source.uri().resolve("/records")).build(),HttpResponse.BodyHandlers.ofByteArray()); assertEquals(200,capture.statusCode()); assertEquals(15000,new ObjectMapper().readTree(capture.body()).size());
            summary.put("inputHash",HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(capture.body()))); summary.put("inputBytes",capture.body().length);
            new ObjectMapper().writeValue(creds.toFile(),Map.of("host","127.0.0.1","port",env.mysql.port(),"database","integration_demo","user","local_test","password","local_test_password"));
            try(Playwright pw=Playwright.create(); Browser browser=pw.chromium().launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(true))) {
                Page page=browser.newPage(); page.navigate(view.uri().resolve("/reference").toString());
                List<String> errors=new ArrayList<>(); page.onPageError(errors::add);
                boolean noOverlap="1".equals(System.getenv("CROSS_VERIFY_NO_OVERLAP"));
                if(noOverlap) readUi(page,env,summary);
                Process sync=env.children.start(new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin","java").toString(),"-cp",System.getProperty("test.runtime.classpath"),"dev.playrightdemo.demo.referencesync.ReferenceSync",creds.toString(),env.source.uri().resolve("/records").toString()).redirectError(ProcessBuilder.Redirect.INHERIT));
                if(!noOverlap) {
                    long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(25);
                    while(sync.isAlive() && System.nanoTime()<until) { try(var c=env.mysql.dataSource().getConnection(); var st=c.createStatement(); var r=st.executeQuery("SELECT COUNT(*) FROM parents")) { r.next(); long n=r.getLong(1); if(n>1 && n<15000) break; } }
                    for(int i=0;i<40 && sync.isAlive();i++) if(readUi(page,env,summary)) { summary.put("overlap","established"); break; }
                }
                assertTrue(sync.waitFor(30,TimeUnit.SECONDS)); assertEquals(0,sync.exitValue());
                try(var c=env.mysql.dataSource().getConnection()) { assertEquals(List.of(),ReferenceRows.compare(expected,ReferenceRows.read(c))); }
                Response finalResponse=page.waitForResponse(r -> r.url().endsWith("/api/reference"), () -> page.getByTestId("refresh").click()); assertEquals(200,finalResponse.status());
                com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(page.getByTestId("result")).hasText("親データ: 15000件"); assertTrue(errors.isEmpty());
                summary.put("finalComparison","PASS"); summary.put("finalUi","PASS");
                if(!"established".equals(summary.get("overlap"))) throw new IllegalStateException("OVERLAP_UNCONFIRMED");
                summary.put("business","PASS");
            }
        }
    }
    private boolean readUi(Page page,ReferenceEnvironment env,Map<String,Object> summary) throws Exception {
        List<Sample> samples=Collections.synchronizedList(new ArrayList<>()); AtomicBoolean active=new AtomicBoolean(true); AtomicReference<Throwable> error=new AtomicReference<>(); AtomicReference<java.sql.Connection> connection=new AtomicReference<>();
        Thread observer=new Thread(() -> { try(var c=env.mysql.dataSource().getConnection()) { connection.set(c); while(active.get()) { double start=now(); try(var s=c.createStatement()) { s.setQueryTimeout(3); try(var r=s.executeQuery("SELECT COUNT(*) FROM parents")) { r.next(); samples.add(new Sample(start,now(),r.getLong(1))); } } } } catch(Throwable e) { error.set(e); } },"jdbc-observer");
        observer.setDaemon(true); env.setCleanupGuard(() -> !observer.isAlive());
        observer.start(); Response response;
        try { response=page.waitForResponse(r -> r.url().endsWith("/api/reference"), () -> page.getByTestId("refresh").click()); com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat(page.getByTestId("result")).hasAttribute("data-state","ready"); response.finished(); }
        finally {
            active.set(false); observer.join(5000);
            if(observer.isAlive()) { var c=connection.get(); if(c!=null) c.abort(Runnable::run); observer.join(5000); }
        }
        if(observer.isAlive()) throw new IllegalStateException("Observer did not stop; database retained"); if(error.get()!=null) throw new IllegalStateException("Observer failed",error.get());
        assertEquals(200,response.status()); var t=response.request().timing(); if(t.requestStart<0||t.responseEnd<t.requestStart) throw new IllegalStateException("HTTP timing unavailable");
        double start=t.startTime+t.requestStart, end=t.startTime+t.responseEnd;
        for(int i=0;i<samples.size();i++) for(int j=i+1;j<samples.size();j++) { Sample a=samples.get(i),b=samples.get(j); if(start+1<=a.start && a.end<=b.start && b.end<=end-1 && a.count!=b.count) { summary.put("httpStart",start); summary.put("httpEnd",end); summary.put("firstObservation",a); summary.put("secondObservation",b); summary.put("clockLimit","same host epoch; 1ms inward margin; clock jumps not excluded"); return true; } }
        return false;
    }
}
