package dev.playrightdemo.demo.dbtunnel;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** TCP bridge for the private RDS port-forward target; contains no DB credentials. */
public final class DbTunnel implements AutoCloseable {
    private final String remoteHost; private final int remotePort; private ServerSocket listener;
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final Object lock = new Object(); private boolean closed;
    public DbTunnel(String remoteHost, int remotePort) {
        if (remoteHost == null || !remoteHost.matches("[a-zA-Z0-9.-]+") || remotePort < 1 || remotePort > 65535) throw new IllegalArgumentException("Invalid tunnel target");
        this.remoteHost = remoteHost; this.remotePort = remotePort;
    }
    public DbTunnel start(String bindHost, int port) throws IOException {
        try {
            synchronized (lock) {
                if (closed || listener != null) throw new IllegalStateException("Tunnel already started or closed");
                listener = new ServerSocket(); listener.bind(new InetSocketAddress(bindHost, port)); workers.submit(this::accept);
            }
            return this;
        } catch (IOException | RuntimeException e) { close(); throw e; }
    }
    public int port() { return listener.getLocalPort(); }
    private boolean register(Socket socket) {
        synchronized (lock) { if (closed) { closeSocket(socket); return false; } sockets.add(socket); return true; }
    }
    private boolean submit(Runnable action) {
        synchronized (lock) {
            if (closed) return false;
            try { workers.submit(action); return true; } catch (java.util.concurrent.RejectedExecutionException e) { return false; }
        }
    }
    private void accept() {
        while (!listener.isClosed()) {
            try {
                Socket incoming = listener.accept(); if (!register(incoming)) continue;
                if (!submit(() -> connect(incoming))) closeSocket(incoming);
            } catch (IOException e) { if (!listener.isClosed()) System.err.println("Tunnel accept failed"); }
        }
    }
    private void connect(Socket incoming) {
        Socket outgoing = new Socket();
        if (!register(outgoing)) { closeSocket(incoming); return; }
        try {
            outgoing.connect(new InetSocketAddress(remoteHost, remotePort), 7000);
            AtomicInteger remaining = new AtomicInteger(2);
            if (!submit(() -> copy(incoming, outgoing, remaining))) { closeSocket(incoming); closeSocket(outgoing); return; }
            copy(outgoing, incoming, remaining);
        } catch (IOException e) { closeSocket(incoming); closeSocket(outgoing); }
    }
    private void copy(Socket from, Socket to, AtomicInteger remaining) {
        try { from.getInputStream().transferTo(to.getOutputStream()); if (!to.isClosed()) to.shutdownOutput(); }
        catch (IOException ignored) { closeSocket(from); closeSocket(to); }
        finally { if (remaining.decrementAndGet() == 0) { closeSocket(from); closeSocket(to); } }
    }
    private void closeSocket(Socket socket) { sockets.remove(socket); try { socket.close(); } catch (IOException ignored) { } }
    @Override public void close() {
        synchronized (lock) {
            if (closed) return;
            closed = true;
            if (listener != null) try { listener.close(); } catch (IOException ignored) { }
            for (Socket socket : sockets) closeSocket(socket);
            workers.shutdownNow();
        }
        try { if (!workers.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("Tunnel workers did not terminate"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IllegalStateException("Interrupted while stopping tunnel", e); }
    }
    public static void main(String[] args) throws Exception {
        DbTunnel tunnel = new DbTunnel(System.getenv("RDS_HOST"), 3306).start("0.0.0.0", Integer.parseInt(System.getenv().getOrDefault("LOCAL_PORT", "3306")));
        Runtime.getRuntime().addShutdownHook(new Thread(tunnel::close));
    }
}
