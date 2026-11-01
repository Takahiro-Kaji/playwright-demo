package learning;

import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

import com.microsoft.playwright.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** 対話端末から exec:java でのみ起動する SSO 入口。URL や認証エラーは出力しない。 */
public class SsoManual {
  static final int OPERATION_TIMEOUT_MS = 15000;
  static final long OVERALL_TIMEOUT_SECONDS = 300;

  public static void main(String[] args) throws Exception {
    try {
      if (args.length == 1 && args[0].equals("--worker")) {
        execute();
        return;
      }
      if (args.length == 1 && args[0].equals("--worker-probe")) {
        if (new BufferedReader(new InputStreamReader(System.in)).readLine() == null)
          throw new IllegalStateException("SSO_STDIN_UNAVAILABLE");
        System.out.println("SSO_STDIN_READY");
        return;
      }
      boolean probe =
          (args.length == 1 && args[0].equals("--probe-stdin"))
              || (args.length == 0 && "1".equals(System.getenv("JAVA_SSO_STDIN_PROBE")));
      if (args.length != 0 && !probe) throw new IllegalArgumentException("SSO_ARGUMENT_INVALID");
      String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
      runBounded(
          List.of(
              java,
              "-cp",
              System.getProperty("java.class.path"),
              SsoManual.class.getName(),
              probe ? "--worker-probe" : "--worker"),
          probe ? 20 : OVERALL_TIMEOUT_SECONDS);
    } catch (Throwable ignored) {
      // 外部へは URL・セレクター・Playwright の例外内容を一切渡さない。
      throw new IllegalStateException("SSO_CHECK_FAILED");
    }
  }

  /** この実行から起動した JVM と、その子孫だけを期限付きで回収する。 */
  static void runBounded(List<String> command, long timeoutSeconds) throws Exception {
    // 列挙不可の環境では子孫の回収を保証できないため、何も起動しない。
    try (var descendants = ProcessHandle.current().descendants()) {
      descendants.count();
    } catch (RuntimeException denied) {
      throw new IllegalStateException("SSO_PROCESS_ENUMERATION_UNAVAILABLE");
    }
    ProcessBuilder builder = new ProcessBuilder(command).inheritIO();
    builder.environment().remove("DEBUG");
    builder.environment().remove("PWDEBUG");
    Process process = builder.start();
    Set<ProcessHandle> owned = new HashSet<>();
    owned.add(process.toHandle());
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds);
    boolean completed = false;
    try {
      while (System.nanoTime() < deadline) {
        process.toHandle().descendants().forEach(owned::add);
        if (process.waitFor(100, TimeUnit.MILLISECONDS)) {
          completed = true;
          break;
        }
      }
      if (!completed) throw new IllegalStateException("SSO_DEADLINE_EXCEEDED");
      if (process.exitValue() != 0) throw new IllegalStateException("SSO_WORKER_FAILED");
    } finally {
      // 記録済みの子孫を先に停止し、PID や起動情報を証跡に出さない。
      boolean enumerationFailed = false;
      try (var descendants = process.toHandle().descendants()) {
        descendants.forEach(owned::add);
      } catch (RuntimeException denied) {
        enumerationFailed = true;
      }
      List<ProcessHandle> handles = new ArrayList<>(owned);
      handles.remove(process.toHandle());
      for (ProcessHandle handle : handles) if (handle.isAlive()) handle.destroy();
      if (process.isAlive()) process.destroy();
      long stopDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
      while (owned.stream().anyMatch(ProcessHandle::isAlive) && System.nanoTime() < stopDeadline)
        Thread.sleep(25);
      for (ProcessHandle handle : owned) if (handle.isAlive()) handle.destroyForcibly();
      long forceDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
      while (owned.stream().anyMatch(ProcessHandle::isAlive) && System.nanoTime() < forceDeadline)
        Thread.sleep(25);
      if (enumerationFailed || owned.stream().anyMatch(ProcessHandle::isAlive))
        throw new IllegalStateException("SSO_PROCESS_STOP_UNCONFIRMED");
    }
  }

  static URI safeUrl(String value) {
    if (value == null) throw new IllegalArgumentException("SSO_CONFIG_INVALID");
    URI uri = URI.create(value).normalize();
    if (!"https".equalsIgnoreCase(uri.getScheme())
        || uri.getHost() == null
        || uri.getUserInfo() != null
        || uri.getRawQuery() != null
        || uri.getRawFragment() != null) throw new IllegalArgumentException("SSO_CONFIG_INVALID");
    return uri;
  }

  static void verify(Page page, URI expected, String selector) {
    URI actual = safeUrl(page.url());
    if (!expected.equals(actual)) throw new IllegalStateException("SSO_URL_MISMATCH");
    assertThat(page.locator(selector)).isVisible();
  }

  static Path createState(Path parent) throws Exception {
    Files.createDirectories(parent);
    Files.setPosixFilePermissions(parent, PosixFilePermissions.fromString("rwx------"));
    Path dir =
        Files.createDirectory(
            parent.resolve(UUID.randomUUID().toString()),
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    return Files.createFile(
        dir.resolve("state.json"),
        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
  }

  static void execute() throws Exception {
    URI start = safeUrl(System.getenv("JAVA_SSO_URL"));
    URI expected = safeUrl(System.getenv("JAVA_SSO_EXPECTED_URL"));
    String selector = System.getenv("JAVA_SSO_SUCCESS_SELECTOR");
    if (selector == null || selector.isBlank())
      throw new IllegalArgumentException("SSO_CONFIG_INVALID");
    Path state = createState(SalesHarness.ROOT.resolve(".local/java-sso"));
    Path dir = state.getParent();
    boolean saved = false, newContext = false, restarted = false;
    try (Playwright pw = Playwright.create()) {
      Browser browser =
          pw.chromium()
              .launch(
                  new BrowserType.LaunchOptions()
                      .setChannel("chrome")
                      .setHeadless(false)
                      .setTimeout(OPERATION_TIMEOUT_MS));
      try {
        BrowserContext context = browser.newContext();
        Page page = context.newPage();
        page.setDefaultTimeout(OPERATION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(OPERATION_TIMEOUT_MS);
        page.navigate(start.toString());
        System.out.println("Complete SSO in Chrome, then press Enter.");
        if (new BufferedReader(new InputStreamReader(System.in)).readLine() == null)
          throw new IllegalStateException("SSO_STDIN_UNAVAILABLE");
        verify(page, expected, selector);
        context.storageState(new BrowserContext.StorageStateOptions().setPath(state));
        if (!Files.getPosixFilePermissions(state)
            .equals(PosixFilePermissions.fromString("rw-------")))
          throw new IllegalStateException("SSO_STATE_PERMISSIONS");
        saved = true;
        BrowserContext fresh =
            browser.newContext(new Browser.NewContextOptions().setStorageStatePath(state));
        Page check = fresh.newPage();
        check.setDefaultTimeout(OPERATION_TIMEOUT_MS);
        check.setDefaultNavigationTimeout(OPERATION_TIMEOUT_MS);
        check.navigate(start.toString());
        verify(check, expected, selector);
        newContext = true;
        fresh.close();
        context.close();
      } finally {
        browser.close();
      }
      Browser headless =
          pw.chromium()
              .launch(
                  new BrowserType.LaunchOptions()
                      .setChannel("chrome")
                      .setHeadless(true)
                      .setTimeout(OPERATION_TIMEOUT_MS));
      try {
        BrowserContext fresh =
            headless.newContext(new Browser.NewContextOptions().setStorageStatePath(state));
        Page check = fresh.newPage();
        check.setDefaultTimeout(OPERATION_TIMEOUT_MS);
        check.setDefaultNavigationTimeout(OPERATION_TIMEOUT_MS);
        check.navigate(start.toString());
        verify(check, expected, selector);
        restarted = true;
        fresh.close();
      } finally {
        headless.close();
      }
    } finally {
      SalesHarness.JSON
          .writerWithDefaultPrettyPrinter()
          .writeValue(
              dir.resolve("summary.json").toFile(),
              Map.of("saved", saved, "newContext", newContext, "headlessRestart", restarted));
      System.out.println("SSO safe summary: " + dir.resolve("summary.json"));
    }
  }
}
