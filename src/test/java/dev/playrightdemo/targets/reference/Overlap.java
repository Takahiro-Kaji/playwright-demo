package dev.playrightdemo.targets.reference;

/** Observations must be fully inside the browser's actual request/response interval. */
public final class Overlap {
    public record Observation(long startEpochMillis, long endEpochMillis, long committedCount) {}
    private Overlap() {}
    public static boolean confirmed(long requestStart, long responseEnd, Observation first, Observation second) {
        return requestStart + 1 <= first.startEpochMillis()
            && first.startEpochMillis() <= first.endEpochMillis()
            && first.endEpochMillis() <= second.startEpochMillis()
            && second.startEpochMillis() <= second.endEpochMillis()
            && second.endEpochMillis() <= responseEnd - 1
            && first.committedCount() != second.committedCount();
    }
}
