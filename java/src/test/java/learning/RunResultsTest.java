package learning;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class RunResultsTest {
    @Test void partialUnconfirmedAndAfterFailureNeverBecomePass() {
        Map<String,Map<String,String>> cases=new LinkedHashMap<>();
        for(int i=0;i<7;i++) cases.put("case"+i,new HashMap<>(Map.of("case","PASS","after","PASS")));
        assertEquals("PASS",RunResults.aggregate(cases));
        cases.get("case0").put("case","NOT_RUN"); assertEquals("PARTIAL",RunResults.aggregate(cases));
        cases.get("case0").put("case","UNCONFIRMED"); assertEquals("UNCONFIRMED",RunResults.aggregate(cases));
        cases.get("case0").put("case","PASS"); cases.get("case1").put("after","FAIL"); assertEquals("FAIL",RunResults.aggregate(cases));
    }
}
