package dev.playrightdemo.foundation;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Persists only caller-supplied, non-secret summary fields. Failure is fatal to the run. */
public final class RunSummary {
    private static final Set<PosixFilePermission> OWNER_ONLY = PosixFilePermissions.fromString("rw-------");
    private final UUID runId = UUID.randomUUID();
    private final Path directory;
    public RunSummary(Path root) { directory = root.resolve(runId.toString()); }
    public UUID runId() { return runId; }
    public Path save(Map<String, ?> fields) throws IOException {
        Files.createDirectories(directory);
        Path temporary = Files.createTempFile(directory, "summary-", ".partial", PosixFilePermissions.asFileAttribute(OWNER_ONLY));
        try {
            new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), fields);
            Path destination = directory.resolve("case-summary.json");
            try { Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException e) { throw new IOException("Atomic summary update unavailable", e); }
            return destination;
        } finally { Files.deleteIfExists(temporary); }
    }
}
