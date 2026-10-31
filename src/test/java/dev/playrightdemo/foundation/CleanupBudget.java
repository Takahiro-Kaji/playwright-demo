package dev.playrightdemo.foundation;

import java.io.IOException;
import java.time.Duration;

/** A monotonic deadline shared by cleanup operations; an expired budget never becomes success. */
public final class CleanupBudget {
    private final long deadline;
    public CleanupBudget(Duration duration) { deadline = System.nanoTime() + duration.toNanos(); }
    public long deadlineNanos() { return deadline; }
    public boolean expired() { return System.nanoTime() >= deadline; }
    public Duration remaining(Duration cap) throws IOException {
        long left=deadline-System.nanoTime();
        if(left<=0) throw new IOException("Cleanup budget exceeded");
        return Duration.ofNanos(Math.min(left,cap.toNanos()));
    }
}
