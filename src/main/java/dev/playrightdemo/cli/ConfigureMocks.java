package dev.playrightdemo.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/** Explicit provisioning command; never prints the admin token or Secret manifest. */
public final class ConfigureMocks {
    private static final ObjectMapper JSON = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private ConfigureMocks() {}
    public static void main(String[] args) throws Exception {
        Path root = Path.of(System.getProperty("playrightdemo.root", ".")).toAbsolutePath().normalize();
        JsonNode output;
        try { output = JSON.readTree(CliProcess.run(List.of("terraform", "-chdir=" + root.resolve("infra"), "output", "-json"), null, Duration.ofSeconds(30))); }
        catch (com.fasterxml.jackson.core.JsonProcessingException error) { throw new IllegalArgumentException("Invalid terraform output"); }
        if (output == null || !output.isObject()) throw new IllegalArgumentException("Invalid terraform output");
        Path dir = Path.of(System.getProperty("playrightdemo.configDir", Path.of(System.getProperty("user.home"), ".config", "play-right-demo").toString()));
        Files.createDirectories(dir); Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------"));
        Path file = dir.resolve("mock-admin.token"), curl = dir.resolve("mock-curl.conf");
        if (Files.isSymbolicLink(file) || Files.isSymbolicLink(curl)) throw new IllegalArgumentException("Credential paths must not be symlinks");
        String token;
        if (Files.exists(file)) token = Files.readString(file).trim();
        else { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); token = HexFormat.of().formatHex(bytes); }
        if (!token.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid existing admin token file");
        privateWrite(file, token + "\n"); privateWrite(curl, "header = \"Authorization: Bearer " + token + "\"\n");
        for (String key : List.of("cluster_name", "secondary_cluster_name")) {
            String context = requiredOutput(output, key);
            CliProcess.run(List.of("kubectl", "--context", context, "apply", "-f", root.resolve("k8s/namespace.yaml").toString()), null, Duration.ofSeconds(30));
            var manifest = Map.of("apiVersion", "v1", "kind", "Secret", "metadata", Map.of("name", "mock-admin", "namespace", "integration-demo"), "type", "Opaque", "stringData", Map.of("token", token));
            CliProcess.run(List.of("kubectl", "--context", context, "-n", "integration-demo", "apply", "-f", "-"), JSON.writeValueAsString(manifest), Duration.ofSeconds(30));
        }
        System.out.println("Two regional mock-admin Secrets configured; private curl config saved.");
    }
    static String requiredOutput(JsonNode output, String key) { JsonNode v = output.path(key).path("value"); if (!v.isTextual() || v.asText().isBlank()) throw new IllegalArgumentException("Missing terraform output: " + key); return v.asText(); }
    static void privateWrite(Path path, String content) throws Exception {
        if (!Files.exists(path)) Files.createFile(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------")); Files.writeString(path, content);
    }
}
