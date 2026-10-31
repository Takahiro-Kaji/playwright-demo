package dev.playrightdemo.foundation;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RunSummaryTest {
    @TempDir Path root;
    @Test void keepsDistinctOwnerOnlyAtomicSummaries() throws Exception {
        RunSummary first = new RunSummary(root), second = new RunSummary(root);
        Path a = first.save(Map.of("business", "FAIL", "restore", "failed"));
        Path b = second.save(Map.of("business", "PASS", "restore", "completed"));
        assertNotEquals(a, b);
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(a)));
        assertTrue(Files.readString(a).contains("FAIL"));
        assertTrue(Files.readString(b).contains("PASS"));
    }
}
