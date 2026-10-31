package dev.playrightdemo.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.playrightdemo.process.OwnedProcesses;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/** Explicit demo schema setup. Credentials travel via a private file or stdin, never argv. */
public final class BootstrapDb {
    private static final ObjectMapper JSON = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private BootstrapDb() {}
    public static void main(String[] args) throws Exception {
        Path root = Path.of(System.getProperty("playrightdemo.root", ".")).toAbsolutePath().normalize();
        String caName = System.getenv("RDS_CA_FILE");
        if (caName == null || !Files.isRegularFile(Path.of(caName))) throw new IllegalArgumentException("RDS_CA_FILE must be an existing CA bundle");
        Path ca = Path.of(caName).toAbsolutePath();
        String region = output(root, "region"), cluster = output(root, "cluster_name"), secondary = output(root, "secondary_cluster_name"), secretArn = output(root, "db_master_secret_arn");
        JsonNode master;
        try { master = JSON.readTree(CliProcess.run(List.of("aws", "secretsmanager", "get-secret-value", "--secret-id", secretArn, "--region", region, "--query", "SecretString", "--output", "text"), null, Duration.ofSeconds(30))); }
        catch (com.fasterxml.jackson.core.JsonProcessingException error) { throw new IllegalArgumentException("Invalid master secret"); }
        if (master == null || !master.path("username").isTextual() || master.path("username").asText().isEmpty() || !master.path("password").isTextual() || master.path("password").asText().isEmpty()) throw new IllegalArgumentException("Invalid master secret");
        Path tmp = Files.createTempDirectory("play-right-bootstrap-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        try {
            Path masterFile = tmp.resolve("master.cnf"); ConfigureMocks.privateWrite(masterFile, config(master.path("username").asText(), master.path("password").asText(), ca));
            String appPassword = secret(), readPassword = secret();
            if (listening(13306)) throw new IllegalStateException("Port 13306 already in use");
            try (var owned = new OwnedProcesses()) {
                Process bridge = owned.start(new ProcessBuilder("kubectl", "--context", cluster, "-n", "integration-demo", "port-forward", "svc/db-tunnel", "13306:3306", "--address", "127.0.0.1").redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD));
                boolean ready = false;
                for (int i = 0; i < 40; i++) { if (!bridge.isAlive()) throw new IllegalStateException("Port-forward exited before readiness"); if (listening(13306)) { ready = true; break; } Thread.sleep(250); }
                if (!ready) throw new IllegalStateException("Port-forward readiness timed out");
                String sql = "CREATE TABLE IF NOT EXISTS integration_demo.items (id BIGINT AUTO_INCREMENT PRIMARY KEY, test_key VARCHAR(64) NOT NULL UNIQUE, status VARCHAR(32) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);\n"
                    + "CREATE USER IF NOT EXISTS 'demo_app'@'%' IDENTIFIED BY '" + appPassword + "' REQUIRE SSL;\nALTER USER 'demo_app'@'%' IDENTIFIED BY '" + appPassword + "' REQUIRE SSL;\nGRANT INSERT, SELECT ON integration_demo.items TO 'demo_app'@'%';\n"
                    + "CREATE USER IF NOT EXISTS 'integration_ro'@'%' IDENTIFIED BY '" + readPassword + "' REQUIRE SSL;\nALTER USER 'integration_ro'@'%' IDENTIFIED BY '" + readPassword + "' REQUIRE SSL;\nGRANT SELECT ON integration_demo.items TO 'integration_ro'@'%';\n";
                CliProcess.run(List.of("mysql", "--defaults-file=" + masterFile, "--host=127.0.0.1", "--port=13306", "--protocol=TCP", "--database=integration_demo", "--batch", "--silent"), sql, Duration.ofSeconds(30));
                for (String context : List.of(cluster, secondary)) {
                    apply(context, Map.of("apiVersion", "v1", "kind", "Secret", "metadata", Map.of("name", "app-db", "namespace", "integration-demo"), "type", "Opaque", "stringData", Map.of("username", "demo_app", "password", appPassword)));
                    apply(context, Map.of("apiVersion", "v1", "kind", "ConfigMap", "metadata", Map.of("name", "rds-ca", "namespace", "integration-demo"), "data", Map.of("global-bundle.pem", Files.readString(ca))));
                }
                Path dir = Path.of(System.getProperty("playrightdemo.configDir", Path.of(System.getProperty("user.home"), ".config", "play-right-demo").toString()));
                Files.createDirectories(dir); Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------"));
                Path target = dir.resolve("mysql-readonly.cnf"); if (Files.isSymbolicLink(target)) throw new IllegalArgumentException("Credential path must not be a symlink");
                ConfigureMocks.privateWrite(target, config("integration_ro", readPassword, ca));
                System.out.println("RDS schema, restricted users, Secret and CA ConfigMap configured; read-only config saved privately.");
            }
        } finally {
            try (var paths = Files.walk(tmp)) { for (Path p : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(p); }
        }
    }
    private static String output(Path root, String name) throws Exception { String v = CliProcess.run(List.of("terraform", "-chdir=" + root.resolve("infra"), "output", "-raw", name), null, Duration.ofSeconds(30)); if (v.isBlank()) throw new IllegalArgumentException("Missing terraform output: " + name); return v; }
    private static void apply(String context, Object manifest) throws Exception { CliProcess.run(List.of("kubectl", "--context", context, "-n", "integration-demo", "apply", "-f", "-"), JSON.writeValueAsString(manifest), Duration.ofSeconds(30)); }
    private static String secret() { byte[] b = new byte[24]; new SecureRandom().nextBytes(b); return HexFormat.of().formatHex(b); }
    private static String escape(String value) { if (value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0 || value.indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid client option value"); return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
    private static String config(String user, String password, Path ca) { return "[client]\nuser=" + escape(user) + "\npassword=" + escape(password) + "\nssl-mode=VERIFY_CA\nssl-ca=" + escape(ca.toString()) + "\n"; }
    private static boolean listening(int port) { try (var socket = new Socket()) { socket.connect(new InetSocketAddress("127.0.0.1", port), 800); return true; } catch (Exception ignored) { return false; } }
}
