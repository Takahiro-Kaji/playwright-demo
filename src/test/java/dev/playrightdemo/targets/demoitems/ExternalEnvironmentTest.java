package dev.playrightdemo.targets.demoitems;

import dev.playrightdemo.foundation.UiEnvironment;
import dev.playrightdemo.foundation.LocalMysql;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ExternalEnvironmentTest {
    private static final ExternalEnvironment.Command READY = (args, timeout) -> args.contains("get") ? "{\"spec\":{\"replicas\":1},\"status\":{\"availableReplicas\":1,\"updatedReplicas\":1,\"observedGeneration\":1},\"metadata\":{\"generation\":1}}" : "";
    @TempDir Path dir;
    private void command(String... args) throws Exception {
        Process p = new ProcessBuilder(args).redirectErrorStream(true).start();
        byte[] output = p.getInputStream().readAllBytes();
        assertEquals(0, p.waitFor(), new String(output));
    }
    private Map<String,String> config() throws Exception {
        Path key = dir.resolve("test.p12"), ca = dir.resolve("ca.pem");
        String tool = Path.of(System.getProperty("java.home"), "bin", "keytool").toString();
        command(tool, "-genkeypair", "-alias", "fixture", "-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=fixture", "-validity", "1", "-storetype", "PKCS12", "-keystore", key.toString(), "-storepass", "fixture-password", "-keypass", "fixture-password", "-noprompt");
        command(tool, "-exportcert", "-rfc", "-alias", "fixture", "-keystore", key.toString(), "-storepass", "fixture-password", "-file", ca.toString());
        Path curl = dir.resolve("curl.conf"), mysql = dir.resolve("mysql.cnf");
        Files.writeString(curl, "header = \"Authorization: Bearer " + "a".repeat(64) + "\"\n");
        Files.writeString(mysql, "[client]\nuser=\"integration_ro\"\npassword=\"synthetic-secret\"\nssl-mode=VERIFY_CA\nssl-ca=\"" + ca + "\"\n");
        Files.setPosixFilePermissions(curl, PosixFilePermissions.fromString("rw-------")); Files.setPosixFilePermissions(mysql, PosixFilePermissions.fromString("rw-------"));
        Map<String,String> e = new HashMap<>();
        e.put("TEST_ENV", "staging"); e.put("REGION_A", "a"); e.put("REGION_B", "b"); e.put("KUBE_CONTEXT_A", "a"); e.put("KUBE_CONTEXT_B", "b"); e.put("KUBE_NAMESPACE", "demo");
        e.put("BASE_URL", "http://127.0.0.1:18080");
        for (String s : List.of("A", "B")) { e.put("APP_URL_" + s, "http://127.0.0.1:18081"); e.put("MOCK_URL_" + s, "http://127.0.0.1:19081"); e.put("MOCK_ADMIN_URL_" + s, "http://127.0.0.1:19181"); }
        e.put("MOCK_CURL_CONFIG", curl.toString()); e.put("MYSQL_OPTIONS_FILE", mysql.toString()); e.put("MYSQL_HOST", "127.0.0.1"); e.put("MYSQL_PORT", "13306"); e.put("MYSQL_DATABASE", "demo"); e.put("MYSQL_USER", "integration_ro"); return e;
    }
    @Test void configuresNonOwningTlsAccessWithoutConnecting() throws Exception {
        var e = config(); Path ca = dir.resolve("ca.pem"), options = Path.of(e.get("MYSQL_OPTIONS_FILE"));
        try (var env = ExternalEnvironment.from(e, READY)) {
            assertFalse(env.disposable()); assertEquals(9, env.metadata().size()); assertFalse(env.metadata().toString().contains("synthetic-secret")); assertEquals(2, env.targets().size()); assertEquals("a".repeat(64), env.mockToken());
            var ds = (com.mysql.cj.jdbc.MysqlDataSource) env.dataSource(); assertEquals("VERIFY_CA", ds.getSslMode()); assertEquals(7000, ds.getSocketTimeout());
            Path store = Path.of(java.net.URI.create(ds.getTrustCertificateKeyStoreUrl())); assertTrue(Files.exists(store));
            assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(store));
            env.setCleanupDeadlineNanos(0); env.close(); assertFalse(Files.exists(store));
        }
        assertTrue(Files.exists(ca)); assertTrue(Files.exists(options));
    }
    @Test void dotenvLoadsAndProcessEnvironmentWins() throws Exception {
        Path file = dir.resolve("env"); Files.writeString(file, "# fixture\nTEST_ENV=staging\nBASE_URL=\"http://example.test\"\n");
        var merged = ExternalEnvironment.loadEnvironment(file, Map.of("TEST_ENV", "test"));
        assertEquals("test", merged.get("TEST_ENV")); assertEquals("http://example.test", merged.get("BASE_URL"));
        assertEquals(Map.of("TEST_ENV", "test"), ExternalEnvironment.loadEnvironment(dir.resolve("absent"), Map.of("TEST_ENV", "test")));
    }
    @Test void malformedReadinessDoesNotExposeResponse() throws Exception {
        var e = config(); var failure = assertThrows(IllegalStateException.class, () -> ExternalEnvironment.from(e, (args, timeout) -> args.contains("get") ? "synthetic-secret {" : ""));
        assertFalse(failure.toString().contains("synthetic-secret")); assertNull(failure.getCause());
    }
    @Test void checksBothContextsAndRejectsUnreadyDeployment() throws Exception {
        var e = config(); var calls = new ArrayList<List<String>>();
        try (var env = ExternalEnvironment.from(e, (args, timeout) -> { calls.add(List.copyOf(args)); return READY.run(args, timeout); })) { assertEquals(8, calls.size()); }
        assertTrue(calls.stream().anyMatch(a -> a.contains("a") && a.contains("deployment/demo-app")));
        assertTrue(calls.stream().anyMatch(a -> a.contains("b") && a.contains("deployment/status-mock")));
        assertThrows(IllegalStateException.class, () -> ExternalEnvironment.from(e, (args, timeout) -> args.contains("get") ? "{}" : ""));
    }
    @Test void rejectsUnsafeOptionsWithoutExposingSecrets() throws Exception {
        var e = config(); e.put("TEST_ENV", "production"); assertThrows(IllegalArgumentException.class, () -> ExternalEnvironment.from(e, READY));
        e.put("TEST_ENV", "staging"); e.put("MOCK_ADMIN_URL_A", "http://example.com:19181"); assertThrows(IllegalArgumentException.class, () -> ExternalEnvironment.from(e, READY));
        e.put("MOCK_ADMIN_URL_A", "http://127.0.0.1:19181"); Path file = Path.of(e.get("MYSQL_OPTIONS_FILE"));
        Files.writeString(file, Files.readString(file) + "!include synthetic-secret\n");
        var error = assertThrows(IllegalArgumentException.class, () -> ExternalEnvironment.from(e, READY)); assertFalse(error.toString().contains("synthetic-secret"));
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--")); assertThrows(IllegalArgumentException.class, () -> ExternalEnvironment.from(e, READY));
    }
}
