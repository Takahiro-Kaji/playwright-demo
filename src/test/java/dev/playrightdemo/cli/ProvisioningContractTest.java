package dev.playrightdemo.cli;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import static org.junit.jupiter.api.Assertions.*;

class ProvisioningContractTest {
    @TempDir Path tmp;
    @Test void mockProvisionUsesPrivateFilesAndStdinWithoutSecretInArgumentsOrLog() throws Exception {
        Path bin = Files.createDirectories(tmp.resolve("bin")), dir = Files.createDirectories(tmp.resolve("config"));
        Path argsLog = tmp.resolve("args.log"), inputLog = tmp.resolve("stdin-used.log");
        String token = "a".repeat(64); Files.writeString(dir.resolve("mock-admin.token"), token + "\n");
        script(bin.resolve("terraform"), "#!/bin/sh\nprintf '%s\\n' '{\"cluster_name\":{\"value\":\"cluster-a\"},\"secondary_cluster_name\":{\"value\":\"cluster-b\"}}'\n");
        script(bin.resolve("kubectl"), "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$FAKE_ARGS\"\ncase \" $* \" in *' -f - '*) cat >/dev/null; echo stdin >> \"$FAKE_INPUT\";; esac\n");
        String cp = List.of(ConfigureMocks.class, ObjectMapper.class, JsonFactory.class, JsonIgnore.class).stream().map(c -> { try { return Path.of(c.getProtectionDomain().getCodeSource().getLocation().toURI()).toString(); } catch (Exception e) { throw new RuntimeException(e); } }).distinct().collect(Collectors.joining(java.io.File.pathSeparator));
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-Dplayrightdemo.root=" + tmp, "-Dplayrightdemo.configDir=" + dir, "-cp", cp, ConfigureMocks.class.getName());
        builder.environment().put("PATH", bin + java.io.File.pathSeparator + builder.environment().getOrDefault("PATH", "/usr/bin:/bin"));
        builder.environment().put("FAKE_ARGS", argsLog.toString()); builder.environment().put("FAKE_INPUT", inputLog.toString());
        builder.redirectErrorStream(true); Process process = builder.start();
        assertTrue(process.waitFor(30, TimeUnit.SECONDS)); String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertEquals(0, process.exitValue(), output); assertFalse(output.contains(token)); assertFalse(Files.readString(argsLog).contains(token));
        assertEquals(2, Files.readAllLines(inputLog).size());
        assertEquals(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE), Files.getPosixFilePermissions(dir.resolve("mock-admin.token")));
        assertEquals(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE), Files.getPosixFilePermissions(dir.resolve("mock-curl.conf")));
        assertTrue(Files.readString(dir.resolve("mock-curl.conf")).contains(token));
    }
    @Test void forwardSetupExitDoesNotLeaveChildrenOrRouter() throws Exception {
        try (var portCheck = new java.net.ServerSocket()) { portCheck.bind(new java.net.InetSocketAddress("127.0.0.1", 18080)); }
        catch (java.io.IOException occupied) { org.junit.jupiter.api.Assumptions.assumeTrue(false, "Local port 18080 already in use"); }
        Path bin = Files.createDirectories(tmp.resolve("forward-bin")); Path pidFile = tmp.resolve("forward-pid");
        script(bin.resolve("terraform"), "#!/bin/sh\nprintf '%s\n' '{\"cluster_name\":{\"value\":\"a\"},\"secondary_cluster_name\":{\"value\":\"b\"},\"region\":{\"value\":\"ra\"},\"secondary_region\":{\"value\":\"rb\"}}'\n");
        script(bin.resolve("kubectl"), "#!/bin/sh\necho $$ >> \"$FAKE_PID\"\nexit 1\n");
        String cp = List.of(PortForward.class, ObjectMapper.class, JsonFactory.class, JsonIgnore.class).stream().map(c -> { try { return Path.of(c.getProtectionDomain().getCodeSource().getLocation().toURI()).toString(); } catch (Exception e) { throw new RuntimeException(e); } }).distinct().collect(Collectors.joining(java.io.File.pathSeparator));
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-Dplayrightdemo.root=" + tmp, "-cp", cp, PortForward.class.getName());
        builder.environment().put("PATH", bin + java.io.File.pathSeparator + builder.environment().getOrDefault("PATH", "/usr/bin:/bin")); builder.environment().put("FAKE_PID", pidFile.toString()); builder.redirectErrorStream(true);
        Process p = builder.start(); assertTrue(p.waitFor(30, TimeUnit.SECONDS)); assertNotEquals(0, p.exitValue());
        assertTrue(Files.exists(pidFile)); for (String line : Files.readAllLines(pidFile)) assertFalse(ProcessHandle.of(Long.parseLong(line)).map(ProcessHandle::isAlive).orElse(false));
        try (var portCheck = new java.net.ServerSocket()) { portCheck.bind(new java.net.InetSocketAddress("127.0.0.1", 18080)); }
    }
    @Test void invalidTerraformJsonDoesNotExposeItsContents() throws Exception {
        Path bin = Files.createDirectories(tmp.resolve("invalid-json-bin"));
        script(bin.resolve("terraform"), "#!/bin/sh\nprintf '%s' '{\"token\":\"fixture-secret-do-not-log\",'\n");
        String cp = List.of(ConfigureMocks.class, ObjectMapper.class, JsonFactory.class, JsonIgnore.class).stream().map(c -> { try { return Path.of(c.getProtectionDomain().getCodeSource().getLocation().toURI()).toString(); } catch (Exception e) { throw new RuntimeException(e); } }).distinct().collect(Collectors.joining(java.io.File.pathSeparator));
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-Dplayrightdemo.root=" + tmp, "-Dplayrightdemo.configDir=" + tmp.resolve("unused"), "-cp", cp, ConfigureMocks.class.getName());
        builder.environment().put("PATH", bin + java.io.File.pathSeparator + builder.environment().getOrDefault("PATH", "/usr/bin:/bin")); builder.redirectErrorStream(true);
        Process p = builder.start(); assertTrue(p.waitFor(30, TimeUnit.SECONDS)); String output = new String(p.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertNotEquals(0, p.exitValue()); assertTrue(output.contains("Invalid terraform output")); assertFalse(output.contains("fixture-secret-do-not-log"));
    }
    @Test void bootstrapUsesVerifiedCaPrivateFileAndReapsFakeBridge() throws Exception { runBootstrap(false); }
    @Test void bootstrapMysqlFailureStillReapsBridgeAndPrivateFiles() throws Exception { runBootstrap(true); }
    private void runBootstrap(boolean failMysql) throws Exception {
        try (var portCheck = new java.net.ServerSocket()) { portCheck.bind(new java.net.InetSocketAddress("127.0.0.1", 13306)); }
        catch (java.io.IOException occupied) { org.junit.jupiter.api.Assumptions.assumeTrue(false, "Local port 13306 already in use"); }
        Path bin = Files.createDirectories(tmp.resolve("bootstrap-bin")), dir = tmp.resolve("config"), io = Files.createDirectories(tmp.resolve("temp"));
        Path ca = tmp.resolve("fake-ca.pem"), pidFile = tmp.resolve("bridge.pid"), calls = tmp.resolve("calls"), marker = tmp.resolve("mysql-marker");
        Files.writeString(ca, "synthetic CA file; mysql is a fake");
        script(bin.resolve("terraform"), "#!/bin/sh\ncase \"$4\" in region) echo region-a;; cluster_name) echo cluster-a;; secondary_cluster_name) echo cluster-b;; db_master_secret_arn) echo fake-arn;; *) exit 2;; esac\n");
        script(bin.resolve("aws"), "#!/bin/sh\nprintf '%s\n' '{\"username\":\"root\",\"password\":\"fixture-master-secret\"}'\n");
        script(bin.resolve("kubectl"), "#!/bin/sh\ncase \" $* \" in *' port-forward '*) echo $$ > \"$FAKE_PID\"; exec \"$FAKE_JAVA\" -cp \"$FAKE_CP\" 'dev.playrightdemo.cli.ProvisioningContractTest$FakeForward';; *' apply '*) cat >/dev/null; echo apply >> \"$FAKE_CALLS\";; *) exit 2;; esac\n");
        script(bin.resolve("mysql"), "#!/bin/sh\nexec \"$FAKE_JAVA\" -cp \"$FAKE_CP\" 'dev.playrightdemo.cli.ProvisioningContractTest$FakeMysql' \"$@\"\n");
        String cp = List.of(BootstrapDb.class, ObjectMapper.class, JsonFactory.class, JsonIgnore.class).stream().map(c -> { try { return Path.of(c.getProtectionDomain().getCodeSource().getLocation().toURI()).toString(); } catch (Exception e) { throw new RuntimeException(e); } }).distinct().collect(Collectors.joining(java.io.File.pathSeparator));
        String testCp = Path.of(ProvisioningContractTest.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
        String javaExe = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        var builder = new ProcessBuilder(javaExe, "-Dplayrightdemo.root=" + tmp, "-Dplayrightdemo.configDir=" + dir, "-Djava.io.tmpdir=" + io, "-cp", cp, BootstrapDb.class.getName());
        var env = builder.environment(); env.put("PATH", bin + java.io.File.pathSeparator + env.getOrDefault("PATH", "/usr/bin:/bin")); env.put("RDS_CA_FILE", ca.toString()); env.put("FAKE_PID", pidFile.toString()); env.put("FAKE_CALLS", calls.toString()); env.put("FAKE_JAVA", javaExe); env.put("FAKE_CP", testCp); env.put("FAKE_MARKER", marker.toString()); env.put("FAKE_FAIL_MYSQL", failMysql ? "1" : "0"); builder.redirectErrorStream(true);
        Process p = builder.start(); assertTrue(p.waitFor(40, TimeUnit.SECONDS)); String output = new String(p.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertEquals(failMysql ? 1 : 0, p.exitValue(), output); assertFalse(output.contains("fixture-master-secret")); assertFalse(output.contains("password="));
        assertTrue(Files.exists(marker)); assertTrue(Files.exists(pidFile)); long pid = Long.parseLong(Files.readString(pidFile).trim());
        assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
        try (var paths = Files.list(io)) { assertEquals(0, paths.count(), "private bootstrap temporary files remain"); }
        if (!failMysql) {
            assertEquals(4, Files.readAllLines(calls).size()); Path readonly = dir.resolve("mysql-readonly.cnf");
            assertEquals(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE), Files.getPosixFilePermissions(readonly));
            String text = Files.readString(readonly); assertTrue(text.contains("ssl-mode=VERIFY_CA")); assertFalse(text.contains("fixture-master-secret"));
        } else assertFalse(Files.exists(calls), "Secret/configmap updates must not occur after DB failure");
    }
    public static final class FakeForward {
        public static void main(String[] args) throws Exception {
            try (var server = new java.net.ServerSocket(13306, 10, java.net.InetAddress.getByName("127.0.0.1"))) { while (true) try (var socket = server.accept()) { } }
        }
    }
    public static final class FakeMysql {
        public static void main(String[] args) throws Exception {
            if (args.length == 0 || !args[0].startsWith("--defaults-file=")) System.exit(3);
            Path config = Path.of(args[0].substring("--defaults-file=".length()));
            if (!Files.getPosixFilePermissions(config).equals(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))) System.exit(4);
            String options = Files.readString(config); String sql = new String(System.in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            if (!options.contains("ssl-mode=VERIFY_CA") || !options.contains("ssl-ca=") || !sql.contains("GRANT SELECT ON integration_demo.items")) System.exit(5);
            for (String arg : args) if (arg.contains("fixture-master-secret")) System.exit(6);
            Files.writeString(Path.of(System.getenv("FAKE_MARKER")), "checked");
            if ("1".equals(System.getenv("FAKE_FAIL_MYSQL"))) System.exit(7);
        }
    }
    @Test void failedCommandDoesNotExposeStderrOrArguments() {
        String secret = "fixture-secret-do-not-log";
        Exception e = assertThrows(Exception.class, () -> CliProcess.run(List.of("/bin/sh", "-c", "echo fixture-secret-do-not-log >&2; exit 7"), null, Duration.ofSeconds(3)));
        assertFalse(e.toString().contains(secret));
    }
    private static void script(Path file, String body) throws Exception { Files.writeString(file, body); Files.setPosixFilePermissions(file, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------")); }
}
