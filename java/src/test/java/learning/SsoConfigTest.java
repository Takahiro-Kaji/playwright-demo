package learning;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SsoConfigTest {
  @Test
  void rejectsCredentialsQueryFragmentAndNonHttps() {
    assertEquals(
        "https://example.invalid/home",
        SsoManual.safeUrl("https://example.invalid/home").toString());
    assertThrows(
        IllegalArgumentException.class,
        () -> SsoManual.safeUrl("https://example.invalid/home?token=secret"));
    assertThrows(
        IllegalArgumentException.class,
        () -> SsoManual.safeUrl("https://example.invalid/home#secret"));
    assertThrows(
        IllegalArgumentException.class,
        () -> SsoManual.safeUrl("https://name:password@example.invalid/home"));
    assertThrows(
        IllegalArgumentException.class, () -> SsoManual.safeUrl("http://example.invalid/home"));
  }

  @Test
  void stateAndParentsArePrivate(@TempDir Path temp) throws Exception {
    Path parent = temp.resolve("sso");
    Path state = SsoManual.createState(parent);
    assertEquals(
        PosixFilePermissions.fromString("rwx------"), Files.getPosixFilePermissions(parent));
    assertEquals(
        PosixFilePermissions.fromString("rwx------"),
        Files.getPosixFilePermissions(state.getParent()));
    assertEquals(
        PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(state));
  }
}
