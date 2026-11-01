package learning;

import java.util.*;

/** 全表の並びと値を、上流や試験対象から生成しない固定期待値と比較する。 */
final class CatalogCheck {
    static Map<String,List<List<Object>>> f1() {
        Map<String,List<List<Object>>> expected=new LinkedHashMap<>();
        expected.put("products", List.of(List.of("P001","ペン",120,1,1),List.of("P002","ノート",300,1,1)));
        expected.put("inventory", List.of(List.of("P001",5),List.of("P002",2)));
        expected.put("orders", List.of()); expected.put("sync_state",List.of(List.of(1,1)));
        return expected;
    }
    static List<String> differences(Map<String,List<List<Object>>> expected, Map<String,List<List<Object>>> actual) {
        List<String> differences=new ArrayList<>();
        for(String table : List.of("products","inventory","orders","sync_state")) {
            if(!Objects.equals(expected.get(table),actual.get(table))) differences.add(table);
        }
        return differences;
    }
}
