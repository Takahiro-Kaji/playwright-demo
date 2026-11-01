package learning;

import com.microsoft.playwright.*;
import org.junit.jupiter.api.Test;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.file.*;
import java.util.Map;
import java.util.UUID;
import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;
import static org.junit.jupiter.api.Assertions.*;

/** 手動実行専用。実 URL と認証済み画面のセレクターは実行環境から与える。 */
class SsoManual {
    @Test void saveAndRestart() throws Exception {
        String url=System.getenv("JAVA_SSO_URL"), selector=System.getenv("JAVA_SSO_SUCCESS_SELECTOR");
        if(url==null || selector==null || selector.isBlank()) throw new IllegalArgumentException("JAVA_SSO_URL and JAVA_SSO_SUCCESS_SELECTOR are required");
        URI uri=URI.create(url); if(!"https".equals(uri.getScheme()) || uri.getUserInfo()!=null) throw new IllegalArgumentException("SSO URL must use HTTPS without embedded credentials");
        Path dir=SalesHarness.ROOT.resolve(".local/java-sso/"+UUID.randomUUID()); Files.createDirectories(dir);
        Files.setPosixFilePermissions(dir, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
        Path state=dir.resolve("state.json"); boolean saved=false, newContext=false, restarted=false;
        try(Playwright pw=Playwright.create()) {
            Browser browser=pw.chromium().launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(false));
            try {
                BrowserContext context=browser.newContext(); Page page=context.newPage(); page.navigate(url);
                System.out.println("Complete SSO in Chrome, then press Enter (no credentials are recorded). ");
                if(new BufferedReader(new InputStreamReader(System.in)).readLine()==null) throw new IllegalStateException("manual input unavailable");
                assertThat(page.locator(selector)).isVisible(); context.storageState(new BrowserContext.StorageStateOptions().setPath(state)); saved=true;
                BrowserContext fresh=browser.newContext(new Browser.NewContextOptions().setStorageStatePath(state));
                Page check=fresh.newPage(); check.navigate(url); assertThat(check.locator(selector)).isVisible(); newContext=true; fresh.close(); context.close();
            } finally { browser.close(); }
            Browser headless=pw.chromium().launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(true));
            try { BrowserContext fresh=headless.newContext(new Browser.NewContextOptions().setStorageStatePath(state));
                Page check=fresh.newPage(); check.navigate(url); assertThat(check.locator(selector)).isVisible(); restarted=true; fresh.close();
            } finally { headless.close(); }
            assertTrue(restarted);
        } finally {
            SalesHarness.JSON.writerWithDefaultPrettyPrinter().writeValue(dir.resolve("summary.json").toFile(),Map.of("saved",saved,"newContext",newContext,"headlessRestart",restarted));
            System.out.println("SSO safe summary: "+dir.resolve("summary.json"));
        }
    }
}
