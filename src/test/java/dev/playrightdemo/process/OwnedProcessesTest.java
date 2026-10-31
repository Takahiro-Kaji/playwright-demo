package dev.playrightdemo.process;

import static org.junit.jupiter.api.Assertions.assertFalse;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class OwnedProcessesTest {
    @Test void stopsAnOwnedProcessAndConfirmsItsExit() throws Exception {
        OwnedProcesses owned = new OwnedProcesses();
        Process process = owned.start(new ProcessBuilder("sleep", "30"));
        owned.stopAll(Duration.ofSeconds(2), Duration.ofSeconds(2));
        assertFalse(process.isAlive());
    }
}
