package dev.playrightdemo.scenarios.ui;

import dev.playrightdemo.targets.demoitems.LocalUiEnvironment;
import dev.playrightdemo.foundation.UiEnvironment;
import java.net.URI;
import java.util.List;
import javax.sql.DataSource;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/** Exercises the shared case against a borrowed, locally hosted environment. */
@Tag("fake-external")
class BorrowedUiContractTest {
    @Test void sharedScenarioLeavesOwnedServersAndRegisteredRowAlone() throws Exception {
        try(LocalUiEnvironment owner=LocalUiEnvironment.start(false,false)) {
            UiEnvironment borrowed=new UiEnvironment() {
                public List<Target> targets() { return owner.targets(); }
                public URI baseUri() { return owner.baseUri(); }
                public DataSource dataSource() { return owner.dataSource(); }
                public String mockToken() { return owner.mockToken(); }
                public boolean disposable() { return false; }
                public void setCleanupDeadlineNanos(long deadline) { }
                public void close() { }
            };
            new UiCaseRunner().execute(200,"a",false,borrowed);
            try(var c=owner.dataSource().getConnection(); var s=c.createStatement(); var r=s.executeQuery("SELECT COUNT(*) FROM items")) { assertTrue(r.next()); assertEquals(1,r.getInt(1)); }
            assertEquals(200,java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(owner.targets().get(0).business().resolve("/status")).build(),java.net.http.HttpResponse.BodyHandlers.discarding()).statusCode());
        }
    }
}
