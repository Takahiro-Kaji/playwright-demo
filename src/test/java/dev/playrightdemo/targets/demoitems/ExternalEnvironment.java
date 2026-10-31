package dev.playrightdemo.targets.demoitems;

import dev.playrightdemo.foundation.UiEnvironment;
import dev.playrightdemo.foundation.LocalMysql;

import com.mysql.cj.jdbc.MysqlDataSource;
import javax.sql.DataSource;
import java.net.URI;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.CertificateFactory;
import java.util.*;
import java.util.regex.Pattern;

/** Explicit, non-owning access to a forwarded non-production environment. */
public final class ExternalEnvironment implements UiEnvironment {
    private final List<Target> targets;
    private final URI base;
    private final DataSource source;
    private final String token;
    private final Path trustStore;
    private final Map<String,String> metadata;

    private ExternalEnvironment(List<Target> targets, URI base, DataSource source, String token, Path trustStore, Map<String,String> metadata) {
        this.targets = List.copyOf(targets); this.base = base; this.source = source; this.token = token; this.trustStore = trustStore; this.metadata = Map.copyOf(metadata);
    }
    public static ExternalEnvironment fromEnvironment() throws Exception { return from(loadEnvironment(Path.of(".env"), System.getenv())); }
    static Map<String,String> loadEnvironment(Path file, Map<String,String> environment) throws Exception {
        Map<String,String> result = new HashMap<>();
        if (Files.exists(file)) {
            for (String line : Files.readAllLines(file)) {
                line = line.trim(); if (line.isEmpty() || line.startsWith("#")) continue;
                var m = Pattern.compile("(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)").matcher(line);
                if (!m.matches()) throw new IllegalArgumentException("Invalid .env configuration");
                String value = m.group(2).trim();
                if (value.length() >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) value = value.substring(1, value.length() - 1);
                result.put(m.group(1), value);
            }
        }
        result.putAll(environment); return result;
    }
    static ExternalEnvironment from(Map<String, String> env) throws Exception { return from(env, ExternalEnvironment::runKubectl); }
    @FunctionalInterface interface Command { String run(List<String> args, long seconds) throws Exception; }
    static ExternalEnvironment from(Map<String, String> env, Command command) throws Exception {
        String profile = required(env, "TEST_ENV");
        if (!Set.of("local", "dev", "test", "staging").contains(profile)) throw new IllegalArgumentException("Explicit non-production TEST_ENV required");
        String regionA = required(env, "REGION_A"), regionB = required(env, "REGION_B");
        String contextA = required(env, "KUBE_CONTEXT_A"), contextB = required(env, "KUBE_CONTEXT_B");
        String namespace = required(env, "KUBE_NAMESPACE");
        if (regionA.equals(regionB) || contextA.equals(contextB)) throw new IllegalArgumentException("Distinct regions and contexts required");
        var targets = List.of(target(env, "A", regionA), target(env, "B", regionB));
        for (String context : List.of(contextA, contextB)) for (String deployment : List.of("demo-app", "status-mock")) checkReady(command, context, namespace, deployment);
        URI base = uri(required(env, "BASE_URL"), false);
        String curl = Files.readString(privateFile(required(env, "MOCK_CURL_CONFIG"))).trim();
        var match = Pattern.compile("header\\s*=\\s*\"Authorization: Bearer ([0-9a-f]{64})\"", Pattern.CASE_INSENSITIVE).matcher(curl);
        if (!match.matches()) throw new IllegalArgumentException("Invalid mock credential configuration");
        Map<String,String> options = readOptions(privateFile(required(env, "MYSQL_OPTIONS_FILE")));
        if (!required(env, "MYSQL_USER").equals(options.get("user"))) throw new IllegalArgumentException("MySQL user mismatch");
        if (!"VERIFY_CA".equals(options.get("ssl-mode"))) throw new IllegalArgumentException("MySQL VERIFY_CA required");
        String host = required(env, "MYSQL_HOST");
        if (!Set.of("127.0.0.1", "localhost", "::1").contains(host)) throw new IllegalArgumentException("MySQL forwarding must use loopback");
        int port;
        try { port = Integer.parseInt(required(env, "MYSQL_PORT")); } catch (NumberFormatException e) { throw new IllegalArgumentException("Invalid MySQL port"); }
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid MySQL port");
        Path ca = Path.of(options.getOrDefault("ssl-ca", ""));
        if (!ca.isAbsolute() || !Files.isRegularFile(ca)) throw new IllegalArgumentException("MySQL CA file required");
        String password = Base64.getUrlEncoder().withoutPadding().encodeToString(new SecureRandom().generateSeed(32));
        KeyStore ks = KeyStore.getInstance("PKCS12"); ks.load(null, password.toCharArray());
        try (var in = Files.newInputStream(ca)) {
            int count = 0; for (var cert : CertificateFactory.getInstance("X.509").generateCertificates(in)) ks.setCertificateEntry("ca-" + count++, cert);
            if (count == 0) throw new IllegalArgumentException("Empty CA bundle");
        }
        Path store = Files.createTempFile("play-right-external-trust-", ".p12", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        try {
            try (var out = Files.newOutputStream(store)) { ks.store(out, password.toCharArray()); }
            MysqlDataSource db = new MysqlDataSource(); db.setServerName(host); db.setPortNumber(port); db.setDatabaseName(required(env, "MYSQL_DATABASE"));
            db.setUser(options.get("user")); db.setPassword(options.get("password")); db.setConnectTimeout(7000); db.setSocketTimeout(7000);
            db.setSslMode("VERIFY_CA"); db.setTrustCertificateKeyStoreUrl(store.toUri().toString()); db.setTrustCertificateKeyStorePassword(password); db.setFallbackToSystemTrustStore(false);
            var metadata = new LinkedHashMap<String,String>();
            for (String name : List.of("TEST_ENV", "KUBE_CONTEXT_A", "KUBE_CONTEXT_B", "KUBE_NAMESPACE", "REGION_A", "REGION_B", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE")) metadata.put(name, required(env, name));
            return new ExternalEnvironment(targets, base, db, match.group(1), store, metadata);
        } catch (Exception e) { Files.deleteIfExists(store); throw e; }
    }
    private static void checkReady(Command command, String context, String namespace, String deployment) throws Exception {
        var common = List.of("kubectl", "--context", context, "--namespace", namespace);
        var rollout = new ArrayList<>(common); rollout.addAll(List.of("rollout", "status", "deployment/" + deployment, "--timeout=60s")); command.run(rollout, 75);
        var get = new ArrayList<>(common); get.addAll(List.of("get", "deployment/" + deployment, "--output=json"));
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
        com.fasterxml.jackson.databind.JsonNode obj;
        try { obj = mapper.readTree(command.run(get, 20)); }
        catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException("Invalid deployment response"); }
        if (obj == null || !obj.isObject()) throw new IllegalStateException("Invalid deployment response");
        int desired = obj.path("spec").path("replicas").asInt(1), available = obj.path("status").path("availableReplicas").asInt(0), updated = obj.path("status").path("updatedReplicas").asInt(0);
        long observed = obj.path("status").path("observedGeneration").asLong(0), generation = obj.path("metadata").path("generation").asLong(0);
        if (desired < 1 || available < desired || updated < desired || observed < generation) throw new IllegalStateException("Deployment not ready: " + deployment);
    }
    private static String runKubectl(List<String> args, long seconds) throws Exception {
        var executor = java.util.concurrent.Executors.newSingleThreadExecutor(r -> { Thread thread = new Thread(r, "deployment-output"); thread.setDaemon(true); return thread; });
        try (var owner = new dev.playrightdemo.process.OwnedProcesses()) {
            Process process = owner.start(new ProcessBuilder(args).redirectError(ProcessBuilder.Redirect.DISCARD));
            var output = executor.submit(() -> { try (var in = process.getInputStream()) { return in.readNBytes(1_000_001); } });
            if (!process.waitFor(seconds, java.util.concurrent.TimeUnit.SECONDS)) throw new IllegalStateException("Deployment check timed out");
            byte[] bytes = output.get(5, java.util.concurrent.TimeUnit.SECONDS);
            if (process.exitValue() != 0 || bytes.length > 1_000_000) throw new IllegalStateException("Deployment check failed");
            return new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
        } finally { executor.shutdownNow(); }
    }
    private static Target target(Map<String,String> env, String suffix, String region) {
        return new Target(region, uri(required(env, "APP_URL_" + suffix), false), uri(required(env, "MOCK_URL_" + suffix), false), uri(required(env, "MOCK_ADMIN_URL_" + suffix), true));
    }
    private static URI uri(String value, boolean admin) {
        URI u; try { u = URI.create(value); } catch (Exception e) { throw new IllegalArgumentException("Invalid endpoint URI"); }
        if (!Set.of("http", "https").contains(u.getScheme()) || u.getHost() == null || u.getUserInfo() != null || u.getFragment() != null) throw new IllegalArgumentException("Invalid endpoint URI");
        if (admin && (!"http".equals(u.getScheme()) || !"127.0.0.1".equals(u.getHost()))) throw new IllegalArgumentException("Mock admin must use loopback HTTP");
        return u;
    }
    private static String required(Map<String,String> env, String name) {
        String value = env.get(name); if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " required"); return value.trim();
    }
    private static Path privateFile(String name) throws Exception {
        Path path = Path.of(name); if (!path.isAbsolute() || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) throw new IllegalArgumentException("Private configuration file required");
        Set<PosixFilePermission> perms = Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS);
        if (perms.stream().anyMatch(p -> p.name().startsWith("GROUP_") || p.name().startsWith("OTHERS_"))) throw new IllegalArgumentException("Private configuration permissions required");
        return path;
    }
    private static Map<String,String> readOptions(Path path) throws Exception {
        Map<String,String> result = new HashMap<>(); boolean section = false;
        for (String line : Files.readAllLines(path)) {
            line = line.trim(); if (line.isEmpty() || line.startsWith("#") || line.startsWith(";")) continue;
            if (line.equals("[client]") && !section) { section = true; continue; }
            var m = Pattern.compile("([a-z-]+)\\s*=\\s*(?:\"((?:[^\"\\\\]|\\\\[\\\\\"])*)\"|([^\\s]+))").matcher(line);
            if (!section || !m.matches() || !Set.of("user", "password", "ssl-mode", "ssl-ca").contains(m.group(1)) || result.containsKey(m.group(1))) throw new IllegalArgumentException("Invalid MySQL options file");
            String value = m.group(2) != null ? m.group(2).replace("\\\"", "\"").replace("\\\\", "\\") : m.group(3);
            result.put(m.group(1), value);
        }
        if (!result.keySet().containsAll(Set.of("user", "password", "ssl-mode", "ssl-ca"))) throw new IllegalArgumentException("Incomplete MySQL options file");
        return result;
    }
    @Override public List<Target> targets() { return targets; }
    @Override public URI baseUri() { return base; }
    @Override public DataSource dataSource() { return source; }
    @Override public String mockToken() { return token; }
    @Override public Map<String,String> metadata() { return metadata; }
    @Override public boolean disposable() { return false; }
    @Override public void setCleanupDeadlineNanos(long deadline) { }
    @Override public void close() throws Exception { Files.deleteIfExists(trustStore); }
}
