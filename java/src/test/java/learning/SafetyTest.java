package learning;

import org.junit.jupiter.api.Test;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class SafetyTest {
    @Test void afterFailureStopsFollowingCasesAndPreservesCaseVerdict() {
        SalesScenariosTest.initialize();
        SalesScenariosTest.stop=false;
        SalesScenariosTest test=new SalesScenariosTest();
        test.name=SalesScenariosTest.NAMES[0];
        SalesScenariosTest.results.get(test.name).put("case","FAIL");
        test.h=new SalesHarness();
        test.h.afterErrors.add(new IllegalStateException("injected restoration failure"));
        assertThrows(AssertionError.class,test::cleanup);
        assertTrue(SalesScenariosTest.stop);
        assertEquals("FAIL",SalesScenariosTest.results.get(test.name).get("case"));
        assertEquals("FAIL",SalesScenariosTest.results.get(test.name).get("after"));
        SalesScenariosTest.stop=false;
    }
    @Test void transitionMustBeInsideSameRequestResponseInterval() {
        SyncObservation observation=new SyncObservation(null,null,"unit");
        observation.attempts.add(Map.of("start",100L,"response",200L));
        observation.samples.add(Map.of("start",90L,"end",99L,"version",1));
        observation.samples.add(Map.of("start",150L,"end",151L,"version",2));
        assertFalse(observation.overlap());
        observation.samples.clear();
        observation.samples.add(Map.of("start",120L,"end",121L,"version",1));
        observation.samples.add(Map.of("start",150L,"end",151L,"version",2));
        assertTrue(observation.overlap());
    }
}
