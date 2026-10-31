package dev.playrightdemo.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.playrightdemo.process.OwnedProcesses;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Owns seven kubectl forwards and the loopback-only random request router. */
public final class PortForward {
    private PortForward() {}
    private record Forward(String context, String service, String ports) {}
    public static void main(String[] args) throws Exception {
        var root = java.nio.file.Path.of(System.getProperty("playrightdemo.root", ".")).toAbsolutePath().normalize();
        com.fasterxml.jackson.databind.JsonNode output;
        try { output = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(CliProcess.run(List.of("terraform", "-chdir=" + root.resolve("infra"), "output", "-json"), null, Duration.ofSeconds(30))); }
        catch (com.fasterxml.jackson.core.JsonProcessingException error) { throw new IllegalArgumentException("Invalid terraform output"); }
        if (output == null || !output.isObject()) throw new IllegalArgumentException("Invalid terraform output");
        String a = ConfigureMocks.requiredOutput(output, "cluster_name"), b = ConfigureMocks.requiredOutput(output, "secondary_cluster_name");
        String ar = ConfigureMocks.requiredOutput(output, "region"), br = ConfigureMocks.requiredOutput(output, "secondary_region");
        if (a.equals(b) || ar.equals(br)) throw new IllegalArgumentException("Two distinct contexts and regions required");
        var forwards = List.of(new Forward(a, "demo-app", "18081:8080"), new Forward(b, "demo-app", "18082:8080"), new Forward(a, "status-mock", "19081:8081"), new Forward(b, "status-mock", "19082:8081"), new Forward(a, "status-mock-admin", "19181:8082"), new Forward(b, "status-mock-admin", "19182:8082"), new Forward(a, "db-tunnel", "13306:3306"));
        System.setProperty("jdk.httpclient.disableRetryConnect", "true");
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
        var owned = new OwnedProcesses(); ExecutorService threads = Executors.newCachedThreadPool();
        AtomicBoolean closing = new AtomicBoolean(), failed = new AtomicBoolean(); CountDownLatch done = new CountDownLatch(1);
        Object lifecycle = new Object();
        HttpServer[] router = new HttpServer[1];
        Runnable stop = () -> {
            HttpServer toClose;
            synchronized (lifecycle) { if (!closing.compareAndSet(false, true)) return; toClose = router[0]; }
            try {
                try { if (toClose != null) toClose.stop(0); } catch (Exception e) { failed.set(true); System.err.println("Router cleanup failed"); }
                try { owned.close(); } catch (Exception e) { failed.set(true); System.err.println("Port-forward cleanup failed"); }
            } finally { threads.shutdownNow(); done.countDown(); }
        };
        Runnable awaitStop = () -> {
            boolean interrupted = false;
            while (true) { try { done.await(); break; } catch (InterruptedException e) { interrupted = true; } }
            if (interrupted) Thread.currentThread().interrupt();
        };
        Thread hook = new Thread(() -> { stop.run(); awaitStop.run(); }, "forward-shutdown"); Runtime.getRuntime().addShutdownHook(hook);
        try {
            for (Forward f : forwards) {
                Process process;
                synchronized (lifecycle) {
                    if (closing.get()) throw new IllegalStateException("Port-forward stopped during setup");
                    process = owned.start(new ProcessBuilder("kubectl", "--context", f.context(), "-n", "integration-demo", "port-forward", "svc/" + f.service(), f.ports(), "--address", "127.0.0.1").redirectError(ProcessBuilder.Redirect.DISCARD));
                }
                CompletableFuture<Void> ready = new CompletableFuture<>();
                threads.submit(() -> {
                    try (var reader = new BufferedReader(new InputStreamReader(process.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                        String line; String marker = "Forwarding from 127.0.0.1:" + f.ports().split(":")[0];
                        while ((line = reader.readLine()) != null) if (line.contains(marker)) ready.complete(null);
                    } catch (Exception e) { ready.completeExceptionally(e); }
                    if (!ready.isDone()) ready.completeExceptionally(new IllegalStateException("Port-forward output closed"));
                });
                process.onExit().thenRun(() -> { if (!closing.get()) { failed.set(true); ready.completeExceptionally(new IllegalStateException("Port-forward exited")); stop.run(); } });
                ready.get(30, TimeUnit.SECONDS);
            }
            synchronized (lifecycle) {
                if (closing.get()) throw new IllegalStateException("Port-forward stopped before router startup");
                router[0] = HttpServer.create(new InetSocketAddress("127.0.0.1", 18080), 0);
                SecureRandom random = new SecureRandom(); router[0].setExecutor(threads);
                router[0].createContext("/", x -> proxy(x, client, random.nextBoolean() ? 18081 : 18082, ar, br)); router[0].start();
            }
            System.out.println("Random ingress ready on 127.0.0.1:18080; Ctrl+C stops owned forwards.");
            done.await();
            if (failed.get()) throw new IllegalStateException("Port-forward exited or cleanup failed");
        } finally {
            stop.run(); awaitStop.run();
            try { Runtime.getRuntime().removeShutdownHook(hook); } catch (IllegalStateException ignored) { }
        }
    }
    private static void proxy(HttpExchange x, HttpClient client, int port, String a, String b) {
        String region = port == 18081 ? a : b;
        try {
            String path = x.getRequestURI().getRawPath(); if (path == null || path.isEmpty()) path = "/";
            String query = x.getRequestURI().getRawQuery();
            URI uri = URI.create("http://127.0.0.1:" + port + path + (query == null ? "" : "?" + query));
            HttpRequest.Builder request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(15));
            Set<String> prohibited = Set.of("host", "connection", "content-length", "transfer-encoding", "upgrade", "expect", "x-routed-region");
            x.getRequestHeaders().forEach((key, values) -> { if (!prohibited.contains(key.toLowerCase(java.util.Locale.ROOT))) for (String value : values) request.header(key, value); });
            request.method(x.getRequestMethod(), HttpRequest.BodyPublishers.ofInputStream(x::getRequestBody));
            var response = client.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
            response.headers().map().forEach((key, values) -> { if (!prohibited.contains(key.toLowerCase(java.util.Locale.ROOT))) x.getResponseHeaders().put(key, values); });
            x.getResponseHeaders().set("cache-control", "no-store"); x.getResponseHeaders().set("x-routed-region", region);
            x.sendResponseHeaders(response.statusCode(), 0);
            try (var body = response.body(); var out = x.getResponseBody()) { body.transferTo(out); }
        } catch (Exception e) {
            try { if (x.getResponseCode() == -1) { x.getResponseHeaders().set("x-routed-region", region); x.sendResponseHeaders(502, -1); } } catch (Exception ignored) { }
            x.close();
        }
    }
}
