package learning;

import java.util.Map;

final class RunResults {
    static String aggregate(Map<String,Map<String,String>> cases) {
        if (cases.values().stream().anyMatch(c->"FAIL".equals(c.get("case")) || "FAIL".equals(c.get("after")))) return "FAIL";
        if (cases.values().stream().anyMatch(c->"UNCONFIRMED".equals(c.get("case")))) return "UNCONFIRMED";
        if (cases.size()!=7 || cases.values().stream().anyMatch(c->"NOT_RUN".equals(c.get("case")))) return "PARTIAL";
        if (cases.values().stream().anyMatch(c->!"PASS".equals(c.get("after")))) return "FAIL";
        return cases.values().stream().allMatch(c->"PASS".equals(c.get("case"))) ? "PASS" : "FAIL";
    }
}
