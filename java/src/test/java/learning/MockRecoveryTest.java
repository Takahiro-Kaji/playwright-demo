package learning;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

/** HTTP 応答が壊れても、変更前に取得したモック状態へ戻すことを検証する。 */
class MockRecoveryTest {
  @Test
  @DisplayName("設定変更が反映され応答が不正な場合も復元する")
  void restoresWhenPutAppliedButResponseIsInvalid() throws Exception {
    AtomicInteger status = new AtomicInteger(200);
    AtomicBoolean corruptNextPut = new AtomicBoolean(true);
    try (MockServer server = new MockServer(status, corruptNextPut)) {
      SalesScenariosTest test = scenario(server);
      try {
        // サーバーは503へ変更してから不正な JSON を返す。
        assertThrows(Exception.class, test::makeMockUnavailable);
        assertTrue(test.mockChanged);
        assertEquals(503, status.get());
        test.cleanup();
        assertEquals(200, status.get());
        assertEquals("PASS", SalesScenariosTest.results.get(test.name).get("after"));
      } finally {
        SalesScenariosTest.stop = false;
      }
    }
  }

  @Test
  @DisplayName("元の状態が200以外でも復元する")
  void restoresOriginalNon200Status() throws Exception {
    AtomicInteger status = new AtomicInteger(503);
    try (MockServer server = new MockServer(status, new AtomicBoolean(false))) {
      SalesScenariosTest test = scenario(server);
      try {
        test.originalMockStatus = test.h.status();
        test.mockChanged = true;
        assertEquals(200, test.h.status(200));
        test.cleanup();
        assertEquals(503, status.get());
        assertEquals("PASS", SalesScenariosTest.results.get(test.name).get("after"));
      } finally {
        SalesScenariosTest.stop = false;
      }
    }
  }

  private SalesScenariosTest scenario(MockServer server) {
    SalesScenariosTest.initialize();
    SalesScenariosTest.stop = false;
    SalesScenariosTest test = new SalesScenariosTest();
    test.name = SalesScenariosTest.NAMES[0];
    test.h = new SalesHarness();
    test.h.upstream = server.url();
    return test;
  }

  private static final class MockServer implements AutoCloseable {
    private final HttpServer server;

    MockServer(AtomicInteger status, AtomicBoolean corruptNextPut) throws Exception {
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      server.createContext(
          "/admin/status",
          exchange -> {
            if (exchange.getRequestMethod().equals("PUT")) {
              var body = SalesHarness.JSON.readTree(exchange.getRequestBody());
              status.set(body.get("status").asInt());
              if (corruptNextPut.getAndSet(false)) {
                respond(exchange, 200, "invalid json");
                return;
              }
            }
            respond(exchange, 200, "{\"status\":" + status.get() + "}");
          });
      server.createContext("/catalog", exchange -> respond(exchange, status.get(), "{}"));
      server.start();
    }

    String url() {
      return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static void respond(HttpExchange exchange, int code, String body) throws IOException {
      byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
      exchange.sendResponseHeaders(code, bytes.length);
      try (var out = exchange.getResponseBody()) {
        out.write(bytes);
      }
    }

    @Override
    public void close() {
      server.stop(0);
    }
  }
}
