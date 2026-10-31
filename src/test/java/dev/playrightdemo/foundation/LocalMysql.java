package dev.playrightdemo.foundation;

import dev.playrightdemo.process.OwnedProcesses;
import com.mysql.cj.jdbc.MysqlDataSource;
import java.io.IOException;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Comparator;
import java.util.concurrent.TimeUnit;

/** Disposable local database; never connects to or removes a shared database. */
public final class LocalMysql implements AutoCloseable {
    private final Path directory;
    private final OwnedProcesses processes = new OwnedProcesses();
    private final MysqlDataSource dataSource;
    private int port;
    private long cleanupDeadline = Long.MAX_VALUE;
    private LocalMysql(Path directory, MysqlDataSource dataSource) { this.directory = directory; this.dataSource = dataSource; }
    public MysqlDataSource dataSource() { return dataSource; }
    public int port() { return port; }
    public void setCleanupDeadlineNanos(long deadline) { cleanupDeadline=deadline; }
    Path directory() { return directory; }
    public static LocalMysql start() throws Exception {
        Path dir = Files.createTempDirectory("play-right-mysql-");
        MysqlDataSource ds = new MysqlDataSource();
        LocalMysql result = new LocalMysql(dir, ds);
        try {
            Path data = Files.createDirectory(dir.resolve("data"));
            Path socket = dir.resolve("mysql.sock");
            result.command("mysqld", "--no-defaults", "--initialize-insecure", "--datadir=" + data);
            int port;
            try (ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) { port = server.getLocalPort(); }
            Process daemon = result.processes.start(new ProcessBuilder("mysqld", "--no-defaults", "--datadir=" + data,
                "--socket=" + socket, "--port=" + port, "--bind-address=127.0.0.1", "--mysqlx=0", "--skip-log-bin",
                "--pid-file=" + dir.resolve("mysql.pid"), "--log-error=" + dir.resolve("mysql.log"))
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD));
            boolean ready = false;
            for (int i = 0; i < 100 && daemon.isAlive(); i++) {
                if (result.commandStatus("mysqladmin", "--no-defaults", "--socket=" + socket, "-u", "root", "ping") == 0) { ready = true; break; }
                Thread.sleep(200);
            }
            if (!ready) throw new IOException("Disposable MySQL did not become ready");
            Process setup = result.processes.start(new ProcessBuilder("mysql", "--no-defaults", "--socket=" + socket, "-u", "root")
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD));
            try (var input = setup.getOutputStream()) { input.write(("CREATE DATABASE integration_demo; CREATE USER 'local_test'@'127.0.0.1' IDENTIFIED BY 'local_test_password'; GRANT ALL ON integration_demo.* TO 'local_test'@'127.0.0.1';").getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            if (!setup.waitFor(20, TimeUnit.SECONDS) || setup.exitValue() != 0) { throw new IOException("Disposable MySQL setup failed"); }
            result.port = port;
            ds.setURL("jdbc:mysql://127.0.0.1:" + port + "/integration_demo?sslMode=DISABLED&allowPublicKeyRetrieval=true&connectTimeout=3000&socketTimeout=3000");
            ds.setUser("local_test"); ds.setPassword("local_test_password");
            return result;
        } catch (Exception e) { try { result.close(); } catch (Exception cleanup) { e.addSuppressed(cleanup); } throw e; }
    }
    private int commandStatus(String... args) throws Exception {
        Process p = processes.start(new ProcessBuilder(args).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD));
        if (!p.waitFor(30, TimeUnit.SECONDS)) { p.destroyForcibly(); if (!p.waitFor(5, TimeUnit.SECONDS)) throw new IOException("Command did not stop"); throw new IOException("Command timed out"); }
        return p.exitValue();
    }
    private void command(String... args) throws Exception { if (commandStatus(args) != 0) throw new IOException(args[0] + " failed"); }
    @Override public void close() throws Exception {
        Exception failure = null;
        try { processes.stopAllUntil(Duration.ofSeconds(5), Duration.ofSeconds(5), cleanupDeadline); } catch (Exception e) { failure = e; }
        if (processes.allStopped()) {
            try { if (Files.exists(directory)) try (var paths = Files.walk(directory)) { for (Path p : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(p); } }
            catch (Exception e) { if (failure == null) failure=e; else failure.addSuppressed(e); }
        }
        if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
        if (failure != null) throw failure;
    }
}
