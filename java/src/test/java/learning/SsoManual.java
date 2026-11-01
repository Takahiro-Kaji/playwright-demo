package learning;

import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

import com.microsoft.playwright.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;
import java.util.UUID;

/** 対話端末から exec:java でのみ起動する SSO 入口。URL や認証エラーは出力しない。 */
public class SsoManual {
  public static void main(String[] args) throws Exception {
    if (args.length == 1 && args[0].equals("--probe-stdin")) {
      if (new BufferedReader(new InputStreamReader(System.in)).readLine() == null)
        throw new IllegalStateException("SSO_STDIN_UNAVAILABLE");
      System.out.println("SSO_STDIN_READY");
      return;
    }
    try {
      execute();
    } catch (Throwable ignored) {
      // Playwright の例外には URL や認証画面の内容が含まれうるため、原因を連結しない。
      throw new IllegalStateException("SSO_CHECK_FAILED");
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
              .launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(false));
      try {
        BrowserContext context = browser.newContext();
        Page page = context.newPage();
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
              .launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(true));
      try {
        BrowserContext fresh =
            headless.newContext(new Browser.NewContextOptions().setStorageStatePath(state));
        Page check = fresh.newPage();
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
