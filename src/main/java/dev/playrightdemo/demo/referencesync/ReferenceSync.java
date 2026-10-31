package dev.playrightdemo.demo.referencesync;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mysql.cj.jdbc.MysqlDataSource;
import javax.sql.DataSource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.Set;

/** Synthetic full-sync command; the dedicated demo schema owns the whole tables. */
public final class ReferenceSync {
    private ReferenceSync() {}
    public static int run(DataSource db, URI source) throws Exception {
        var request = HttpRequest.newBuilder(source).timeout(Duration.ofSeconds(10)).GET().build();
        var response = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build().send(request, HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() < 200 || response.statusCode() >= 300) throw new IllegalStateException("Upstream HTTP " + response.statusCode());
        JsonNode rows = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(response.body()); if (rows == null || !rows.isArray()) throw new IllegalArgumentException("Expected JSON array");
        for (var row : rows) {
            if (!row.isObject() || !decimalId(row.get("id")) || !text(row.get("destination")) || !text(row.get("label")) || !nullableText(row.get("note")) || !row.path("children").isArray()) throw new IllegalArgumentException("Invalid parent record");
            for (var item : row.path("children")) if (!item.isObject() || !decimalId(item.get("id")) || !text(item.get("destination")) || !nullableText(item.get("value"))) throw new IllegalArgumentException("Invalid child record");
        }
        try (var c = db.getConnection()) {
            c.setAutoCommit(true);
            try (var st = c.createStatement()) { st.executeUpdate("DELETE FROM children"); st.executeUpdate("DELETE FROM parents"); }
            try (var parent = c.prepareStatement("INSERT INTO parents (id, destination, label, note) VALUES (?, ?, ?, ?)"); var child = c.prepareStatement("INSERT INTO children (id, parent_id, destination, value) VALUES (?, ?, ?, ?)")) {
                for (var row : rows) {
                    parent.setString(1, row.path("id").asText()); parent.setString(2, row.path("destination").asText()); parent.setString(3, row.path("label").asText());
                    if (row.path("note").isNull()) parent.setNull(4, java.sql.Types.VARCHAR); else parent.setString(4, row.path("note").asText()); parent.executeUpdate();
                    for (var item : row.path("children")) { child.setString(1, item.path("id").asText()); child.setString(2, row.path("id").asText()); child.setString(3, item.path("destination").asText()); if (item.path("value").isNull()) child.setNull(4, java.sql.Types.VARCHAR); else child.setString(4, item.path("value").asText()); child.executeUpdate(); }
                }
            }
        }
        return rows.size();
    }
    private static boolean text(JsonNode value) { return value != null && value.isTextual(); }
    private static boolean nullableText(JsonNode value) { return value != null && (value.isNull() || value.isTextual()); }
    private static boolean decimalId(JsonNode value) { return text(value) && value.textValue().matches("[0-9]{1,20}"); }
    public static void main(String[] args) {
        try {
            if (args.length != 2) throw new IllegalArgumentException("Usage: ReferenceSync <private-credentials.json> <source-url>");
            Path credentialFile = Path.of(args[0]);
            if (Files.getFileStore(credentialFile).supportsFileAttributeView("posix")) {
                Set<PosixFilePermission> perms = Files.getPosixFilePermissions(credentialFile);
                if (perms.stream().anyMatch(p -> p.name().startsWith("GROUP_") || p.name().startsWith("OTHERS_"))) throw new IllegalArgumentException("Credentials file must be private");
            }
            JsonNode cfg = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(Files.readAllBytes(credentialFile));
            if (!"127.0.0.1".equals(cfg.path("host").asText())) throw new IllegalArgumentException("Demo sync restricted to local MySQL");
            MysqlDataSource ds = new MysqlDataSource(); ds.setServerName("127.0.0.1"); ds.setPortNumber(cfg.path("port").asInt()); ds.setUser(cfg.path("user").asText()); ds.setPassword(cfg.path("password").asText()); ds.setDatabaseName(cfg.path("database").asText()); ds.setSslMode("DISABLED"); ds.setAllowPublicKeyRetrieval(true);
            run(ds, URI.create(args[1]));
        } catch (Exception e) { System.err.println("Reference sync failed: " + e.getClass().getSimpleName()); System.exit(1); }
    }
}
