package dev.playrightdemo.demo.statusmock;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** One in-memory mock instance per region; conditional updates are atomic per process. */
public final class StatusMock implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private final Object lock = new Object();
    private final String region, token, instanceId = UUID.randomUUID().toString();
    private int status;
    private long version;
    private HttpServer business, admin;
    private ExecutorService executor;

    public StatusMock(String region, String token, int initialStatus) {
        if (region == null || region.isBlank() || token == null || token.length() < 32 || initialStatus < 200 || initialStatus > 599)
            throw new IllegalArgumentException("Region, token and valid status required");
        this.region = region; this.token = token; this.status = initialStatus;
    }
    private Map<String, Object> stateLocked() { return Map.of("region", region, "status", status, "version", version, "instanceId", instanceId); }
    public Map<String, Object> state() { synchronized (lock) { return stateLocked(); } }
    public StatusMock start(String host, int businessPort, int adminPort) throws IOException {
        try {
            business = HttpServer.create(new InetSocketAddress(host, businessPort), 0);
            admin = HttpServer.create(new InetSocketAddress(host, adminPort), 0);
            executor = Executors.newCachedThreadPool();
            business.setExecutor(executor); admin.setExecutor(executor);
            business.createContext("/", this::handleBusiness); admin.createContext("/", this::handleAdmin);
            business.start(); admin.start(); return this;
        } catch (IOException | RuntimeException e) { close(); throw e; }
    }
    public URI businessUri() { return URI.create("http://127.0.0.1:" + business.getAddress().getPort()); }
    public URI adminUri() { return URI.create("http://127.0.0.1:" + admin.getAddress().getPort()); }
    private static void headers(HttpExchange x, Map<String, Object> state) {
        x.getResponseHeaders().set("cache-control", "no-store");
        x.getResponseHeaders().set("x-mock-region", state.get("region").toString());
        x.getResponseHeaders().set("x-mock-version", state.get("version").toString());
        x.getResponseHeaders().set("x-mock-instance-id", state.get("instanceId").toString());
    }
    private void handleBusiness(HttpExchange x) throws IOException {
        Map<String, Object> snapshot = state(); headers(x, snapshot);
        int code = 404;
        if ("GET".equals(x.getRequestMethod()) && "/healthz".equals(x.getRequestURI().getPath())) code = 200;
        if ("GET".equals(x.getRequestMethod()) && "/status".equals(x.getRequestURI().getPath()))
            code = x.getRequestURI().getRawQuery() == null ? (int) snapshot.get("status") : 400;
        x.sendResponseHeaders(code, -1); x.close();
    }
    private void reply(HttpExchange x, int code, Object value, Map<String, Object> snapshot) throws IOException {
        headers(x, snapshot); byte[] bytes = JSON.writeValueAsBytes(value);
        x.getResponseHeaders().set("content-type", "application/json"); x.sendResponseHeaders(code, bytes.length);
        try (var out = x.getResponseBody()) { out.write(bytes); }
    }
    private void handleAdmin(HttpExchange x) throws IOException {
        byte[] given = x.getRequestHeaders().getFirst("Authorization") == null ? new byte[0] : x.getRequestHeaders().getFirst("Authorization").getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(given, ("Bearer " + token).getBytes(StandardCharsets.UTF_8))) { reply(x, 401, Map.of("error", "unauthorized"), state()); return; }
        if (!"/admin/status".equals(x.getRequestURI().toString())) { reply(x, 404, Map.of("error", "not-found"), state()); return; }
        if ("GET".equals(x.getRequestMethod())) { Map<String, Object> s = state(); reply(x, 200, s, s); return; }
        if (!"PUT".equals(x.getRequestMethod())) { reply(x, 405, Map.of("error", "method-not-allowed"), state()); return; }
        byte[] body = x.getRequestBody().readNBytes(1025);
        if (body.length > 1024) { reply(x, 413, Map.of("error", "too-large"), state()); return; }
        JsonNode data;
        try { data = JSON.readTree(body); } catch (Exception e) { reply(x, 400, Map.of("error", "invalid-json"), state()); return; }
        if (data == null || !data.isObject() || !data.has("status") || !data.get("status").isIntegralNumber() || !data.get("status").canConvertToInt() || data.get("status").intValue() < 200 || data.get("status").intValue() > 599 || data.size() > (data.has("expected") ? 2 : 1)) {
            reply(x, 400, Map.of("error", "status-must-be-integer-200-to-599"), state()); return;
        }
        JsonNode expected = data.get("expected");
        if (expected != null && (!expected.isObject() || expected.size() != 4 || !expected.hasNonNull("region") || !expected.get("region").isTextual() || !expected.hasNonNull("instanceId") || !expected.get("instanceId").isTextual() || !expected.hasNonNull("version") || !expected.get("version").isIntegralNumber() || !expected.get("version").canConvertToLong() || expected.get("version").longValue() < 0 || expected.get("version").longValue() > 9007199254740991L || !expected.hasNonNull("status") || !expected.get("status").isIntegralNumber() || !expected.get("status").canConvertToInt() || expected.get("status").intValue() < 200 || expected.get("status").intValue() > 599)) {
            reply(x, 400, Map.of("error", "invalid-expected-state"), state()); return;
        }
        Map<String, Object> after; boolean conflict;
        synchronized (lock) {
            conflict = expected != null && (!region.equals(expected.get("region").asText()) || !instanceId.equals(expected.get("instanceId").asText()) || status != expected.get("status").intValue() || version != expected.get("version").longValue());
            if (!conflict) { status = data.get("status").intValue(); version++; }
            after = stateLocked();
        }
        reply(x, conflict ? 409 : 200, conflict ? Map.of("error", "state-conflict", "current", after) : after, after);
    }
    @Override public void close() { if (business != null) business.stop(0); if (admin != null) admin.stop(0); if (executor != null) executor.shutdownNow(); }
    public static void main(String[] args) throws Exception {
        String region = System.getenv("APP_REGION"), token = System.getenv("MOCK_ADMIN_TOKEN");
        StatusMock mock = new StatusMock(region, token, 200).start("0.0.0.0", Integer.parseInt(System.getenv().getOrDefault("PORT", "8081")), Integer.parseInt(System.getenv().getOrDefault("ADMIN_PORT", "8082")));
        Runtime.getRuntime().addShutdownHook(new Thread(mock::close));
    }
}
