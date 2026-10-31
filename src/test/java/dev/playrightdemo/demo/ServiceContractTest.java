package dev.playrightdemo.demo;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.playrightdemo.demo.app.DemoApp;
import dev.playrightdemo.demo.statusmock.StatusMock;
import org.junit.jupiter.api.Test;
import javax.sql.DataSource;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import static org.junit.jupiter.api.Assertions.*;

class ServiceContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "a".repeat(64);
    private static final HttpClient HTTP = HttpClient.newHttpClient();
    private static HttpRequest.Builder admin(URI uri) { return HttpRequest.newBuilder(uri.resolve("/admin/status")).header("authorization", "Bearer " + TOKEN); }
    private static HttpResponse<String> send(HttpRequest request) throws Exception { return HTTP.send(request, HttpResponse.BodyHandlers.ofString()); }
    private static HttpRequest put(URI uri, Object value) throws Exception { return admin(uri).header("content-type", "application/json").PUT(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(value))).build(); }

    @Test void mockCasIsAtomicAndRestoresDistinctOriginalStates() throws Exception {
        try (var a = new StatusMock("a", TOKEN, 200).start("127.0.0.1", 0, 0); var b = new StatusMock("b", TOKEN, 429).start("127.0.0.1", 0, 0)) {
            var originalA = a.state(); var originalB = b.state();
            var first = HTTP.sendAsync(put(a.adminUri(), Map.of("status", 503, "expected", originalA)), HttpResponse.BodyHandlers.ofString());
            var second = HTTP.sendAsync(put(a.adminUri(), Map.of("status", 503, "expected", originalA)), HttpResponse.BodyHandlers.ofString());
            var results = List.of(first.join().statusCode(), second.join().statusCode()).stream().sorted().toList();
            assertEquals(List.of(200, 409), results);
            assertEquals(200, send(put(b.adminUri(), Map.of("status", 503, "expected", originalB))).statusCode());
            assertEquals(503, send(HttpRequest.newBuilder(a.businessUri().resolve("/status")).GET().build()).statusCode());
            assertEquals(200, send(put(a.adminUri(), Map.of("status", 200, "expected", a.state()))).statusCode());
            assertEquals(200, send(put(b.adminUri(), Map.of("status", 429, "expected", b.state()))).statusCode());
            assertEquals(200, send(HttpRequest.newBuilder(a.businessUri().resolve("/status")).GET().build()).statusCode());
            assertEquals(429, send(HttpRequest.newBuilder(b.businessUri().resolve("/status")).GET().build()).statusCode());
            assertEquals(401, send(HttpRequest.newBuilder(a.adminUri().resolve("/admin/status")).GET().build()).statusCode());
        }
    }
    @Test void casRejectsEachIdentityMismatchWithoutMutation() throws Exception {
        try (var mock = new StatusMock("a", TOKEN, 200).start("127.0.0.1", 0, 0)) {
            var before = mock.state();
            for (String field : List.of("region", "version", "instanceId")) {
                var expected = new java.util.HashMap<String, Object>(before);
                expected.put(field, field.equals("version") ? ((Number) before.get("version")).longValue() + 1 : "different");
                assertEquals(409, send(put(mock.adminUri(), Map.of("status", 503, "expected", expected))).statusCode(), field);
                assertEquals(before, mock.state(), field);
                assertEquals(200, send(HttpRequest.newBuilder(mock.businessUri().resolve("/status")).GET().build()).statusCode(), field);
            }
        }
    }
    @Test void appUsesMockAndInsertsOnlyOnSuccess() throws Exception {
        List<String> inserted = new java.util.concurrent.CopyOnWriteArrayList<>();
        DataSource db = dataSource(inserted);
        String key = "it-00000000-0000-0000-0000-000000000001";
        try (var mock = new StatusMock("a", TOKEN, 200).start("127.0.0.1", 0, 0); var app = new DemoApp("a", mock.businessUri(), db).start("127.0.0.1", 0)) {
            String requestBody = JSON.writeValueAsString(Map.of("testKey", key));
            var request = HttpRequest.newBuilder(app.uri().resolve("/api/items")).header("content-type", "application/json").POST(HttpRequest.BodyPublishers.ofString(requestBody)).build();
            var ok = send(request); assertEquals(201, ok.statusCode()); assertEquals("200", ok.headers().firstValue("x-external-status").orElseThrow());
            assertEquals(List.of(key, "CREATED"), inserted);
            assertEquals(200, send(put(mock.adminUri(), Map.of("status", 503, "expected", mock.state()))).statusCode());
            var bad = send(request); assertEquals(502, bad.statusCode()); assertEquals("503", bad.headers().firstValue("x-external-status").orElseThrow());
            assertEquals(List.of(key, "CREATED"), inserted);
            var page = send(HttpRequest.newBuilder(app.uri().resolve("/items/new")).GET().build()); assertEquals(200, page.statusCode()); assertTrue(page.body().contains("item-create-result"));
            var script = send(HttpRequest.newBuilder(app.uri().resolve("/form.js")).GET().build()); assertTrue(script.body().contains("外部システムエラー"));
        }
    }
    @Test void trailingJsonIsRejectedWithoutMutation() throws Exception {
        try (var mock = new StatusMock("a", TOKEN, 200).start("127.0.0.1", 0, 0)) {
            var before = mock.state();
            var invalid = admin(mock.adminUri()).header("content-type", "application/json").PUT(HttpRequest.BodyPublishers.ofString("{\"status\":503} {}" )).build();
            assertEquals(400, send(invalid).statusCode()); assertEquals(before, mock.state());
            List<String> inserted = new java.util.concurrent.CopyOnWriteArrayList<>();
            try (var app = new DemoApp("a", mock.businessUri(), dataSource(inserted)).start("127.0.0.1", 0)) {
                var request = HttpRequest.newBuilder(app.uri().resolve("/api/items")).POST(HttpRequest.BodyPublishers.ofString("{\"testKey\":\"it-00000000-0000-0000-0000-000000000001\"} {}" )).build();
                assertEquals(400, send(request).statusCode()); assertTrue(inserted.isEmpty());
            }
        }
        var source = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        source.createContext("/", x -> { byte[] data = "[] []".getBytes(StandardCharsets.UTF_8); x.sendResponseHeaders(200, data.length); try (var out = x.getResponseBody()) { out.write(data); } }); source.start();
        try { assertThrows(com.fasterxml.jackson.core.JsonProcessingException.class, () -> dev.playrightdemo.demo.referencesync.ReferenceSync.run(dataSource(new ArrayList<>()), URI.create("http://127.0.0.1:" + source.getAddress().getPort() + "/"))); }
        finally { source.stop(0); }
    }
    @Test void tunnelClosesActiveConnectionsAndRejectsNewConnections() throws Exception {
        try (var remote = new java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            var accepted = new java.util.concurrent.CompletableFuture<java.net.Socket>();
            var thread = new Thread(() -> { try { accepted.complete(remote.accept()); } catch (Exception e) { accepted.completeExceptionally(e); } }); thread.start();
            try (var tunnel = new dev.playrightdemo.demo.dbtunnel.DbTunnel("127.0.0.1", remote.getLocalPort()).start("127.0.0.1", 0); var client = new java.net.Socket("127.0.0.1", tunnel.port()); var backend = accepted.get(3, java.util.concurrent.TimeUnit.SECONDS)) {
                client.setSoTimeout(3000); tunnel.close();
                try { assertEquals(-1, client.getInputStream().read()); } catch (java.net.SocketException acceptable) { /* Reset is also a closed connection. */ }
            }
            thread.join(3000); assertFalse(thread.isAlive());
        }
    }
    private static DataSource dataSource(List<String> inserted) {
        return (DataSource) Proxy.newProxyInstance(ServiceContractTest.class.getClassLoader(), new Class<?>[]{DataSource.class}, (obj, method, args) -> {
            if (method.getName().equals("getConnection")) return Proxy.newProxyInstance(ServiceContractTest.class.getClassLoader(), new Class<?>[]{Connection.class}, (conn, cm, ca) -> {
                if (cm.getName().equals("prepareStatement")) {
                    assertEquals("INSERT INTO items (test_key, status) VALUES (?, ?)", ca[0]);
                    String[] values = new String[2];
                    return Proxy.newProxyInstance(ServiceContractTest.class.getClassLoader(), new Class<?>[]{PreparedStatement.class}, (st, sm, sa) -> {
                        if (sm.getName().equals("setString")) { values[(int) sa[0] - 1] = (String) sa[1]; return null; }
                        if (sm.getName().equals("executeUpdate")) { inserted.addAll(List.of(values)); return 1; }
                        return defaultValue(sm.getReturnType());
                    });
                }
                return defaultValue(cm.getReturnType());
            });
            return defaultValue(method.getReturnType());
        });
    }
    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive() || type == void.class) return null;
        if (type == boolean.class) return false; if (type == int.class) return 0; if (type == long.class) return 0L;
        throw new IllegalArgumentException("Unexpected primitive: " + type);
    }
}
