package dev.playrightdemo.demo.app;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import javax.sql.DataSource;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/** Minimal application contract, with DB connections borrowed and closed per request. */
public final class DemoApp implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final Pattern KEY = Pattern.compile("it-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private final String region; private final URI mock; private final DataSource db;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
    private HttpServer server; private ExecutorService executor;
    public DemoApp(String region, URI mock, DataSource db) { this.region = region; this.mock = mock; this.db = db; }
    public DemoApp start(String host, int port) throws IOException {
        try { server = HttpServer.create(new InetSocketAddress(host, port), 0); executor = Executors.newCachedThreadPool(); server.setExecutor(executor); server.createContext("/", this::handle); server.start(); return this; }
        catch (IOException | RuntimeException e) { close(); throw e; }
    }
    public URI uri() { return URI.create("http://127.0.0.1:" + server.getAddress().getPort()); }
    private static void json(HttpExchange x, int code, Object data) throws IOException { byte[] body = JSON.writeValueAsBytes(data); x.getResponseHeaders().set("content-type", "application/json; charset=utf-8"); x.getResponseHeaders().set("cache-control", "no-store"); x.sendResponseHeaders(code, body.length); try (var o = x.getResponseBody()) { o.write(body); } }
    private static void resource(HttpExchange x, String name, String contentType) throws IOException {
        byte[] body;
        try (var in = DemoApp.class.getResourceAsStream("/demo/app/" + name)) { if (in == null) throw new IOException("Missing resource " + name); body = in.readAllBytes(); }
        x.getResponseHeaders().set("content-type", contentType); x.getResponseHeaders().set("cache-control", "no-store");
        if (name.endsWith(".html")) x.getResponseHeaders().set("content-security-policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'none'; object-src 'none'");
        x.sendResponseHeaders(200, body.length); try (var o = x.getResponseBody()) { o.write(body); }
    }
    private void handle(HttpExchange x) throws IOException {
        x.getResponseHeaders().set("x-app-region", region);
        try { dispatch(x); } catch (Exception e) { if (x.getResponseCode() == -1) json(x, 500, Map.of("error", "internal-error")); else x.close(); }
    }
    private void dispatch(HttpExchange x) throws Exception {
        String path = x.getRequestURI().getPath(), method = x.getRequestMethod();
        if ("GET".equals(method) && "/healthz".equals(path)) { json(x, 200, Map.of("ready", true)); return; }
        if ("GET".equals(method) && ("/".equals(path) || "/items/new".equals(path))) { resource(x, "items.html", "text/html; charset=utf-8"); return; }
        if ("GET".equals(method) && "/form.js".equals(path)) { resource(x, "form.js", "text/javascript; charset=utf-8"); return; }
        if (!"POST".equals(method) || !"/api/items".equals(path)) { json(x, 404, Map.of("error", "not-found")); return; }
        JsonNode data; try { byte[] body = x.getRequestBody().readNBytes(8193); if (body.length > 8192) throw new IllegalArgumentException(); data = JSON.readTree(body); }
        catch (Exception e) { json(x, 400, Map.of("error", "invalid-json")); return; }
        if (data == null || !data.isObject() || data.size() != 1 || !data.hasNonNull("testKey") || !data.get("testKey").isTextual() || !KEY.matcher(data.get("testKey").textValue()).matches()) { json(x, 400, Map.of("error", "invalid-request")); return; }
        HttpResponse<Void> response;
        try { response = http.send(HttpRequest.newBuilder(mock.resolve("/status")).timeout(Duration.ofSeconds(3)).GET().build(), HttpResponse.BodyHandlers.discarding()); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); json(x, 502, Map.of("error", "mock-unreachable")); return; }
        catch (IOException e) { json(x, 502, Map.of("error", "mock-unreachable")); return; }
        x.getResponseHeaders().set("x-external-status", Integer.toString(response.statusCode()));
        for (String name : new String[]{"x-mock-region", "x-mock-version", "x-mock-instance-id"}) x.getResponseHeaders().set(name, response.headers().firstValue(name).orElse("missing"));
        if (!region.equals(response.headers().firstValue("x-mock-region").orElse(null))) { json(x, 502, Map.of("error", "wrong-mock-region")); return; }
        if (response.statusCode() < 200 || response.statusCode() >= 300) { json(x, 502, Map.of("error", "external-system-unavailable", "externalStatus", response.statusCode())); return; }
        try (var c = db.getConnection(); var statement = c.prepareStatement("INSERT INTO items (test_key, status) VALUES (?, ?)")) {
            statement.setString(1, data.get("testKey").textValue()); statement.setString(2, "CREATED"); statement.executeUpdate();
        } catch (SQLException e) { json(x, e.getErrorCode() == 1062 ? 409 : 500, Map.of("error", "database-insert-failed")); return; }
        json(x, 201, Map.of("status", "CREATED", "testKey", data.get("testKey").textValue()));
    }
    @Override public void close() { if (server != null) server.stop(0); if (executor != null) executor.shutdownNow(); }
    public static void main(String[] args) throws Exception {
        var cfg = AppDataSource.fromEnvironment(); DemoApp app = null;
        try {
            app = new DemoApp(System.getenv().getOrDefault("APP_REGION", "local"), URI.create(System.getenv().getOrDefault("MOCK_URL", "http://status-mock:8081")), cfg.dataSource()).start("local".equals(System.getenv("TEST_PROFILE")) ? "127.0.0.1" : "0.0.0.0", Integer.parseInt(System.getenv().getOrDefault("PORT", "8080")));
            DemoApp running = app;
            Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { running.close(); } finally { cfg.close(); } }));
        } catch (Exception | Error error) {
            if (app != null) try { app.close(); } catch (Exception cleanup) { error.addSuppressed(cleanup); }
            try { cfg.close(); } catch (Exception cleanup) { error.addSuppressed(cleanup); }
            throw error;
        }
    }
}
