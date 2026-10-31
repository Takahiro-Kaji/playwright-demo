package dev.playrightdemo.demo.referenceview;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import javax.sql.DataSource;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Read-only reference demo; connections are closed per request. */
public final class ReferenceView implements AutoCloseable {
    private final DataSource db; private HttpServer server; private ExecutorService executor;
    public ReferenceView(DataSource db) { this.db = db; }
    public ReferenceView start(String host, int port) throws IOException {
        try { server = HttpServer.create(new InetSocketAddress(host, port), 0); executor = Executors.newCachedThreadPool(); server.setExecutor(executor); server.createContext("/", this::handle); server.start(); return this; }
        catch (IOException | RuntimeException e) { close(); throw e; }
    }
    public URI uri() { return URI.create("http://127.0.0.1:" + server.getAddress().getPort()); }
    private void handle(HttpExchange x) throws IOException {
        try {
            String path = x.getRequestURI().getPath();
            if (!"GET".equals(x.getRequestMethod())) { x.sendResponseHeaders(404, -1); x.close(); return; }
            byte[] data; String type;
            if ("/api/reference".equals(path)) {
                try (var c = db.getConnection(); var st = c.createStatement(); var rows = st.executeQuery("SELECT COUNT(*) AS count FROM parents")) { rows.next(); data = new ObjectMapper().writeValueAsBytes(Map.of("count", rows.getLong(1))); }
                type = "application/json";
            } else if ("/reference".equals(path) || "/reference.js".equals(path)) {
                boolean html = "/reference".equals(path); String resource = html ? "reference.html" : "reference.js";
                try (var in = ReferenceView.class.getResourceAsStream("/demo/referenceview/" + resource)) { if (in == null) throw new IOException("Missing resource"); data = in.readAllBytes(); }
                type = html ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8";
                if (html) x.getResponseHeaders().set("content-security-policy", "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'");
            } else { x.sendResponseHeaders(404, -1); x.close(); return; }
            x.getResponseHeaders().set("content-type", type); x.getResponseHeaders().set("cache-control", "no-store"); x.sendResponseHeaders(200, data.length); try (var out = x.getResponseBody()) { out.write(data); }
        } catch (Exception e) { if (x.getResponseCode() == -1) { x.sendResponseHeaders(500, -1); } x.close(); }
    }
    public static void main(String[] args) throws Exception {
        var cfg = dev.playrightdemo.demo.app.AppDataSource.fromEnvironment(); ReferenceView view = null;
        try {
            view = new ReferenceView(cfg.dataSource()).start("127.0.0.1", Integer.parseInt(System.getenv().getOrDefault("PORT", "0")));
            ReferenceView running = view;
            Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { running.close(); } finally { cfg.close(); } }));
            System.out.println("READY " + view.uri().getPort());
        } catch (Exception | Error error) {
            if (view != null) try { view.close(); } catch (Exception cleanup) { error.addSuppressed(cleanup); }
            try { cfg.close(); } catch (Exception cleanup) { error.addSuppressed(cleanup); }
            throw error;
        }
    }
    @Override public void close() { if (server != null) server.stop(0); if (executor != null) executor.shutdownNow(); }
}
