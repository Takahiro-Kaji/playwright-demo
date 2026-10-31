package dev.playrightdemo.targets.reference;

import java.sql.Connection;
import java.util.*;

/** Full table reads retain duplicate and orphan rows, and BIGINT ids remain strings. */
public final class ReferenceRows {
    public record Parent(String id, String destination, String label, String note) {}
    public record Child(String id, String parentId, String destination, String value) {}
    public record Snapshot(List<Parent> parents, List<Child> children) {}
    public record Difference(String table, String id, String kind) {}
    private ReferenceRows() {}
    public static Snapshot read(Connection c) throws Exception {
        List<Parent> p = new ArrayList<>(); List<Child> ch = new ArrayList<>();
        try(var s=c.createStatement(); var r=s.executeQuery("SELECT CAST(id AS CHAR), destination, label, note FROM parents")) { while(r.next()) p.add(new Parent(r.getString(1),r.getString(2),r.getString(3),r.getString(4))); }
        try(var s=c.createStatement(); var r=s.executeQuery("SELECT CAST(id AS CHAR), CAST(parent_id AS CHAR), destination, value FROM children")) { while(r.next()) ch.add(new Child(r.getString(1),r.getString(2),r.getString(3),r.getString(4))); }
        return new Snapshot(p,ch);
    }
    public static List<Difference> compare(Snapshot expected, Snapshot actual) {
        List<Difference> d = new ArrayList<>();
        compareRows("parents", expected.parents(), actual.parents(), Parent::id, d);
        compareRows("children", expected.children(), actual.children(), Child::id, d);
        return d;
    }
    private static <T> void compareRows(String table,List<T> expected,List<T> actual,java.util.function.Function<T,String> id,List<Difference> d) {
        Map<String,List<T>> grouped = new LinkedHashMap<>();
        for(T row:actual) grouped.computeIfAbsent(id.apply(row),k->new ArrayList<>()).add(row);
        Set<String> wanted = new HashSet<>();
        for(T row:expected) {
            String key=id.apply(row); if(!wanted.add(key)) throw new IllegalArgumentException("Duplicate expected key");
            List<T> found=grouped.get(key);
            if(found==null) d.add(new Difference(table,key,"missing"));
            else { if(found.size()>1) d.add(new Difference(table,key,"duplicate")); if(!found.get(0).equals(row)) {
                T got=found.get(0); String kind="value";
                if(row instanceof Parent p && got instanceof Parent q && !Objects.equals(p.destination(),q.destination())) kind="destination";
                if(row instanceof Child p && got instanceof Child q) {
                    if(!Objects.equals(p.parentId(),q.parentId())) kind="relation";
                    else if(!Objects.equals(p.destination(),q.destination())) kind="destination";
                }
                d.add(new Difference(table,key,kind));
            } }
        }
        for(String key:grouped.keySet()) if(!wanted.contains(key)) d.add(new Difference(table,key,"extra"));
    }
}
