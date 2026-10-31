package dev.playrightdemo.scenarios.batch;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.playrightdemo.demo.referencesource.ReferenceSource;
import dev.playrightdemo.foundation.LocalMysql;
import dev.playrightdemo.foundation.RunSummary;
import dev.playrightdemo.process.OwnedProcesses;
import dev.playrightdemo.targets.reference.ReferenceRows;
import dev.playrightdemo.targets.reference.ReferenceEnvironment;
import dev.playrightdemo.targets.reference.ReferenceRows.*;
import java.net.http.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

@Tag("local-batch")
public class LocalBatchTest {
    @Test void captureSyncAndCompareWholeTables() throws Exception {
        RunSummary run = new RunSummary(Path.of(".local", "runs"));
        Map<String,Object> summary = new LinkedHashMap<>();
        summary.put("runId",run.runId().toString()); summary.put("caseId","batch/full-import");
        summary.put("business","unconfirmed"); summary.put("environmentCleanup","unconfirmed");
        Throwable failure=null;
        try { execute(summary); } catch(Throwable e) { failure=e; if("unconfirmed".equals(summary.get("business"))) summary.put("business","FAIL"); }
        summary.put("runner",failure==null?"passed":"failed");
        try { run.save(summary); } catch(Throwable e) { if(failure==null) failure=e; else failure.addSuppressed(e); }
        if(failure!=null) throw new AssertionError("Batch run failed; runId="+run.runId(),failure);
    }
    private void execute(Map<String,Object> summary) throws Exception {
        Map<String,String> hashes=new LinkedHashMap<>();
        for(String file:List.of("src/test/java/dev/playrightdemo/scenarios/batch/LocalBatchTest.java", "src/test/java/dev/playrightdemo/targets/reference/ReferenceRows.java", "src/test/java/dev/playrightdemo/targets/reference/ReferenceEnvironment.java", "src/test/java/dev/playrightdemo/foundation/LocalMysql.java", "src/main/java/dev/playrightdemo/demo/referencesync/ReferenceSync.java")) hashes.put(file,HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(Path.of(file)))));
        summary.put("sourceHashes",hashes);
        var p1 = new LinkedHashMap<String,Object>(); p1.put("id","9007199254740993"); p1.put("destination","east"); p1.put("label","Alpha"); p1.put("note",null); p1.put("children",List.of(Map.of("id","9007199254741001","destination","east","value","")));
        var p2 = Map.of("id","9007199254740995","destination","west","label","Beta","note","","children",List.of(Map.of("id","9007199254741002","destination","west","value","value")));
        List<Object> records=new ArrayList<>(List.of(p1,p2));
        List<Parent> parents=new ArrayList<>(List.of(new Parent("9007199254740993","east","Alpha",null),new Parent("9007199254740995","west","Beta","")));
        List<Child> childrenExpected=new ArrayList<>(List.of(new Child("9007199254741001","9007199254740993","east",""),new Child("9007199254741002","9007199254740995","west","value")));
        boolean large="30000".equals(System.getenv("BATCH_SIZE"));
        if(large) for(int i=2;i<15000;i++) {
            String parentId=Long.toString(100000L+i), childId=Long.toString(200000L+i), label="Parent-"+i;
            records.add(Map.of("id",parentId,"destination","east","label",label,"note","", "children",List.of(Map.of("id",childId,"destination","east","value","v"))));
            parents.add(new Parent(parentId,"east",label,"")); childrenExpected.add(new Child(childId,parentId,"east","v"));
        }
        Snapshot expected = new Snapshot(parents,childrenExpected);
        summary.put("expectedParentCount",parents.size()); summary.put("expectedChildCount",childrenExpected.size());
        Path creds=Files.createTempFile("play-right-credentials-", ".json", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        try(ReferenceEnvironment env = ReferenceEnvironment.start(creds, records, summary)) {
            LocalMysql mysql = env.mysql; ReferenceSource source = env.source; OwnedProcesses children = env.children;
            try(var c=mysql.dataSource().getConnection(); var s=c.createStatement()) {
                s.execute("CREATE TABLE parents (id BIGINT UNSIGNED NOT NULL, destination VARCHAR(20) NOT NULL, label VARCHAR(64) NOT NULL, note VARCHAR(64) NULL)");
                s.execute("CREATE TABLE children (id BIGINT UNSIGNED NOT NULL, parent_id BIGINT UNSIGNED NOT NULL, destination VARCHAR(20) NOT NULL, value VARCHAR(64) NULL)");
                s.execute("INSERT INTO parents VALUES (1,'old','obsolete',NULL)"); s.execute("INSERT INTO children VALUES (2,1,'old','obsolete')");
            }
            var response=HttpClient.newHttpClient().send(HttpRequest.newBuilder(source.uri().resolve("/records")).build(),HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(200,response.statusCode()); assertEquals(parents.size(),new ObjectMapper().readTree(response.body()).size());
            String inputHash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(response.body()));
            summary.put("inputHash",inputHash); summary.put("inputBytes",response.body().length); summary.put("scope","all rows in dedicated parents and children tables");
            new ObjectMapper().writeValue(creds.toFile(),Map.of("host","127.0.0.1","port",mysql.port(),"database","integration_demo","user","local_test","password","local_test_password"));
            long started=System.nanoTime();
            Process sync=children.start(new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin","java").toString(),"-cp",System.getProperty("test.runtime.classpath"),"dev.playrightdemo.demo.referencesync.ReferenceSync",creds.toString(),source.uri().resolve("/records").toString()).redirectError(ProcessBuilder.Redirect.INHERIT));
            assertTrue(sync.waitFor(30,TimeUnit.SECONDS)); assertEquals(0,sync.exitValue());
            summary.put("syncMillis",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started));
            try(var c=mysql.dataSource().getConnection()) {
                assertEquals(List.of(),ReferenceRows.compare(expected,ReferenceRows.read(c)));
                String[] faults={"DELETE FROM parents WHERE id=9007199254740993", "INSERT INTO parents SELECT * FROM parents WHERE id=9007199254740993", "INSERT INTO parents VALUES (3,'x','extra',NULL)", "UPDATE children SET destination='bad' WHERE id=9007199254741001", "UPDATE children SET parent_id=3 WHERE id=9007199254741001", "UPDATE parents SET label='bad' WHERE id=9007199254740993", "INSERT INTO children VALUES (2,1,'old','obsolete')", "UPDATE parents SET note='' WHERE id=9007199254740993", "UPDATE parents SET id=9007199254740992 WHERE id=9007199254740993"};
                String[] kinds={"missing","duplicate","extra","destination","relation","value","extra","value","missing"};
                String[] ids={"9007199254740993","9007199254740993","3","9007199254741001","9007199254741001","9007199254740993","2","9007199254740993","9007199254740993"};
                for(int i=0;i<faults.length;i++) { c.setAutoCommit(false); try(var s=c.createStatement()) { s.executeUpdate(faults[i]); } var differences=ReferenceRows.compare(expected,ReferenceRows.read(c)); final int j=i; assertTrue(differences.stream().anyMatch(d -> d.id().equals(ids[j]) && d.kind().equals(kinds[j])),faults[i]); c.rollback(); c.setAutoCommit(true); }
            }
            summary.put("comparisonMillis",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started));
            summary.put("observedJvmHeapBytes",Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory());
            summary.put("measurementLimit", "single JVM heap observation, not a peak; excludes child and database");
            summary.put("business","PASS"); summary.put("faultsDetected",9);
        }
    }
}
