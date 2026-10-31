package dev.playrightdemo.cli;

import dev.playrightdemo.process.OwnedProcesses;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Bounded direct argv execution; neither stderr nor arguments are echoed on failure. */
final class CliProcess {
    private CliProcess() {}
    static String run(List<String> argv, String input, Duration timeout) throws Exception {
        try (var owned = new OwnedProcesses()) {
            Process process = owned.start(new ProcessBuilder(argv).redirectError(ProcessBuilder.Redirect.DISCARD));
            var io = Executors.newFixedThreadPool(2);
            try {
                var output = io.submit(() -> {
                    try (var stream = process.getInputStream(); var buf = new ByteArrayOutputStream()) {
                        byte[] bytes = new byte[8192]; int n;
                        while ((n = stream.read(bytes)) != -1) { if (buf.size() + n > 1024 * 1024) { process.destroyForcibly(); throw new IOException("Command output exceeds limit"); } buf.write(bytes, 0, n); }
                        return buf.toString(StandardCharsets.UTF_8);
                    }
                });
                var writer = io.submit(() -> { try (var stream = process.getOutputStream()) { if (input != null) stream.write(input.getBytes(StandardCharsets.UTF_8)); } return null; });
                if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) throw new IOException("Command timed out: " + argv.get(0));
                writer.get(5, TimeUnit.SECONDS);
                String text = output.get(5, TimeUnit.SECONDS);
                if (process.exitValue() != 0) throw new IOException("Command failed: " + argv.get(0) + " (exit " + process.exitValue() + ")");
                return text.trim();
            } finally { io.shutdownNow(); }
        }
    }
}
