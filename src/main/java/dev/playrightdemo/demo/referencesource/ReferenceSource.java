package dev.playrightdemo.demo.referencesource;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** In-memory local reference source, including intentionally broken responses for verification. */
public final class ReferenceSource implements AutoCloseable {
    private final byte[] records; private HttpServer server; private ExecutorService executor;
    public ReferenceSource(List<?> records) throws IOException { this.records = new ObjectMapper().writeValueAsBytes(records); }
    public ReferenceSource start(String host, int port) throws IOException {
        try {
            server = HttpServer.create(new InetSocketAddress(host, port), 0); executor = Executors.newCachedThreadPool(); server.setExecutor(executor);
            server.createContext("/", x -> {
                String path = x.getRequestURI().getPath();
                if ("/invalid".equals(path)) { byte[] b = "{".getBytes(java.nio.charset.StandardCharsets.UTF_8); x.sendResponseHeaders(200, b.length); try (var out = x.getResponseBody()) { out.write(b); } return; }
                if ("/broken".equals(path)) { x.sendResponseHeaders(200, 100); x.getResponseBody().write('['); x.close(); return; }
                if (!"/records".equals(path)) { x.sendResponseHeaders(404, -1); x.close(); return; }
                x.getResponseHeaders().set("content-type", "application/json"); x.sendResponseHeaders(200, records.length); try (var out = x.getResponseBody()) { out.write(records); }
            }); server.start(); return this;
        } catch (IOException | RuntimeException e) { close(); throw e; }
    }
    public URI uri() { return URI.create("http://127.0.0.1:" + server.getAddress().getPort()); }
    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("Usage: ReferenceSource <records.json>");
        List<?> records = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readValue(java.nio.file.Files.readAllBytes(java.nio.file.Path.of(args[0])), List.class);
        ReferenceSource source = new ReferenceSource(records).start("127.0.0.1", Integer.parseInt(System.getenv().getOrDefault("PORT", "0")));
        Runtime.getRuntime().addShutdownHook(new Thread(source::close));
        System.out.println("READY " + source.uri().getPort());
    }
    @Override public void close() { if (server != null) server.stop(0); if (executor != null) executor.shutdownNow(); }
}
