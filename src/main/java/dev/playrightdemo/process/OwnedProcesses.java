package dev.playrightdemo.process;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Tracks processes at launch, rather than discovering ownership at cleanup time. */
public final class OwnedProcesses implements AutoCloseable {
    private record Owned(Process process, long pid, Instant started) {}
    private final List<Owned> owned = new ArrayList<>();
    private boolean closed;

    public synchronized Process start(ProcessBuilder builder) throws IOException {
        if (closed) throw new IllegalStateException("Process owner is closed");
        Process process = builder.start();
        Instant started = process.toHandle().info().startInstant().orElse(null);
        owned.add(new Owned(process, process.pid(), started));
        return process;
    }

    public synchronized void stopAll(Duration grace, Duration forceWait) throws IOException, InterruptedException { stopAllUntil(grace, forceWait, Long.MAX_VALUE); }
    public synchronized void stopAllUntil(Duration grace, Duration forceWait, long globalDeadline) throws IOException, InterruptedException {
        List<String> failed = new ArrayList<>();
        boolean interrupted = Thread.interrupted();
        for (int i = owned.size() - 1; i >= 0; i--) {
            Owned item = owned.get(i);
            Process process = item.process();
            if (!process.isAlive()) continue;
            if (item.started() != null && !process.toHandle().info().startInstant().map(item.started()::equals).orElse(false)) {
                failed.add("ownership changed for pid " + item.pid());
                continue;
            }
            process.destroy();
            long deadline = Math.min(globalDeadline, System.nanoTime() + grace.toNanos());
            while (process.isAlive() && System.nanoTime() < deadline) {
                try { process.waitFor(Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline-System.nanoTime())), TimeUnit.MILLISECONDS); }
                catch (InterruptedException e) { interrupted = true; }
            }
            if (process.isAlive()) {
                process.destroyForcibly(); deadline = Math.min(globalDeadline, System.nanoTime() + forceWait.toNanos());
                while (process.isAlive() && System.nanoTime() < deadline) {
                    try { process.waitFor(Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline-System.nanoTime())), TimeUnit.MILLISECONDS); }
                    catch (InterruptedException e) { interrupted = true; }
                }
                if (process.isAlive()) failed.add("still running pid " + item.pid());
            }
        }
        if (interrupted) {
            InterruptedException e = new InterruptedException("Interrupted while stopping owned processes");
            if (!failed.isEmpty()) e.addSuppressed(new IOException(String.join(", ", failed)));
            throw e;
        }
        if (!failed.isEmpty()) throw new IOException(String.join(", ", failed));
    }

    public synchronized boolean allStopped() { return owned.stream().noneMatch(item -> item.process().isAlive()); }

    @Override public synchronized void close() throws IOException {
        closed = true;
        try { stopAll(Duration.ofSeconds(5), Duration.ofSeconds(5)); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("Interrupted while stopping owned processes", e); }
    }
}
