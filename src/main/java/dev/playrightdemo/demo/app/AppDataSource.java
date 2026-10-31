package dev.playrightdemo.demo.app;

import com.mysql.cj.jdbc.MysqlDataSource;
import javax.sql.DataSource;
import java.io.InputStream;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.CertificateFactory;
import java.util.Base64;

/** Per-process JDBC configuration. Production requires a CA and hostname verification. */
public final class AppDataSource implements AutoCloseable {
    private final MysqlDataSource source; private final Path trustStore;
    private AppDataSource(MysqlDataSource source, Path trustStore) { this.source = source; this.trustStore = trustStore; }
    public DataSource dataSource() { return source; }
    public static AppDataSource fromEnvironment() throws Exception {
        String host = required("DB_HOST"), ca = System.getenv("DB_CA_FILE");
        boolean local = "local".equals(System.getenv("TEST_PROFILE"));
        if (local && !"127.0.0.1".equals(host)) throw new IllegalArgumentException("Local DB must use loopback");
        if (!local && (ca == null || ca.isBlank())) throw new IllegalArgumentException("DB_CA_FILE required for TLS");
        MysqlDataSource ds = new MysqlDataSource(); ds.setServerName(host); ds.setPortNumber(Integer.parseInt(System.getenv().getOrDefault("DB_PORT", "3306")));
        ds.setDatabaseName(System.getenv().getOrDefault("DB_NAME", "integration_demo")); ds.setUser(required("DB_USER")); ds.setPassword(System.getenv().getOrDefault("DB_PASSWORD", "")); ds.setConnectTimeout(7000);
        Path store = null;
        try {
            if (local) { ds.setSslMode("DISABLED"); ds.setAllowPublicKeyRetrieval(true); }
            else {
                byte[] secret = new byte[32]; new SecureRandom().nextBytes(secret); String password = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
                KeyStore ks = KeyStore.getInstance("PKCS12"); ks.load(null, password.toCharArray());
                try (InputStream in = Files.newInputStream(Path.of(ca))) { int index = 0; for (var cert : CertificateFactory.getInstance("X.509").generateCertificates(in)) ks.setCertificateEntry("ca-" + index++, cert); if (index == 0) throw new IllegalArgumentException("Empty CA bundle"); }
                store = Files.createTempFile("play-right-trust-", ".p12", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                try (var out = Files.newOutputStream(store)) { ks.store(out, password.toCharArray()); }
                ds.setSslMode("VERIFY_IDENTITY"); ds.setTrustCertificateKeyStoreUrl(store.toUri().toString()); ds.setTrustCertificateKeyStorePassword(password); ds.setFallbackToSystemTrustStore(false);
            }
            return new AppDataSource(ds, store);
        } catch (Exception e) { if (store != null) Files.deleteIfExists(store); throw e; }
    }
    private static String required(String name) { String value = System.getenv(name); if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " required"); return value; }
    @Override public void close() { if (trustStore != null) try { Files.deleteIfExists(trustStore); } catch (java.io.IOException e) { throw new java.io.UncheckedIOException("Trust store cleanup failed", e); } }
}
