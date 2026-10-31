package dev.playrightdemo.foundation;

import java.net.URI;
import java.util.List;
import javax.sql.DataSource;

/** Access boundary for the same UI scenario against a disposable or non-owned environment. */
public interface UiEnvironment extends AutoCloseable {
    record Target(String region, URI app, URI business, URI admin) {}
    List<Target> targets();
    URI baseUri();
    DataSource dataSource();
    String mockToken();
    boolean disposable();
    default java.util.Map<String,String> metadata() { return java.util.Map.of(); }
    void setCleanupDeadlineNanos(long deadline);
    @Override void close() throws Exception;
}
