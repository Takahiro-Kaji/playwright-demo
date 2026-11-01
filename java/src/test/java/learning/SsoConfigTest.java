package learning;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.io.TempDir;

class SsoConfigTest {
  @Test
  @DisplayName("認証情報・クエリ・フラグメントを含むURLとHTTPS以外を拒否する")
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
  @DisplayName("認証状態ファイルと親ディレクトリを非公開にする")
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

  @Test
  @DisplayName("期限切れ時は対象ワーカーとその子プロセスだけを止める")
  void timeoutStopsOnlyTheWorkerAndItsChild(@TempDir Path temp) throws Exception {
    Path pidFile = temp.resolve("child.pid");
    String script =
        "const cp=require('node:child_process').spawn(process.execPath,"
            + "['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});"
            + "require('node:fs').writeFileSync(process.argv[1],String(cp.pid));"
            + "setInterval(()=>{},1000)";
    long start = System.nanoTime();
    assertThrows(
        IllegalStateException.class,
        () -> SsoManual.runBounded(java.util.List.of("node", "-e", script, pidFile.toString()), 2));
    assertTrue(java.util.concurrent.TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - start) < 10);
    assertTrue(Files.exists(pidFile));
    long childPid = Long.parseLong(Files.readString(pidFile));
    assertFalse(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false));
  }
}
