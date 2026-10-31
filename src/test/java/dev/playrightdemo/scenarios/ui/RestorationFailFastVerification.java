package dev.playrightdemo.scenarios.ui;

import org.junit.jupiter.api.*;
import java.nio.file.*;

@Tag("verification")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class RestorationFailFastVerification {
    @BeforeEach void checkStopGuard() { if(!"1".equals(System.getenv("UI_VERIFY_RESTORE_FAIL"))) throw new IllegalStateException("Fault flag required"); UiCaseRunner.requireSafeEnvironment(); }
    @Test @Order(1) void restorationFailureStopsRun() throws Exception {
        new UiCaseRunner().execute(503,"a",false);
    }
    @Test @Order(2) void sentinelMustNotRun() throws Exception {
        Files.writeString(Path.of(".local", "sentinel-ran"), "unexpected");
    }
}
