package dev.playrightdemo.foundation;

import java.nio.file.Files;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

@Tag("local-batch")
class LocalMysqlInterruptTest {
    @Test void interruptDoesNotPreventReapingAndRemovingDedicatedDatabase() throws Exception {
        LocalMysql mysql=LocalMysql.start(); var directory=mysql.directory();
        Thread.currentThread().interrupt();
        try { assertThrows(InterruptedException.class, mysql::close); assertFalse(Files.exists(directory)); assertTrue(Thread.currentThread().isInterrupted()); }
        finally { Thread.interrupted(); }
    }
}
