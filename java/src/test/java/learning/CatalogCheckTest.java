package learning;

import org.junit.jupiter.api.Test;
import java.sql.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class CatalogCheckTest {
    @Test void sqlFaultsAreDetected() throws Exception {
        Class.forName("org.sqlite.JDBC");
        try(Connection c=DriverManager.getConnection("jdbc:sqlite::memory:"); Statement s=c.createStatement()) {
            s.execute("CREATE TABLE products(product_code TEXT,name TEXT,price INTEGER,active INTEGER,version INTEGER)");
            s.execute("CREATE TABLE inventory(product_code TEXT,quantity INTEGER)");
            s.execute("CREATE TABLE orders(order_id TEXT,product_code TEXT,quantity INTEGER,unit_price INTEGER,status TEXT)");
            s.execute("CREATE TABLE sync_state(id INTEGER,catalog_version INTEGER)");
            s.execute("INSERT INTO products VALUES('P001','ペン',120,1,1),('P002','ノート',300,1,1)");
            s.execute("INSERT INTO inventory VALUES('P001',5),('P002',2)"); s.execute("INSERT INTO sync_state VALUES(1,1)");
            assertTrue(CatalogCheck.differences(CatalogCheck.f1(),snapshot(c)).isEmpty());
            String[] faults={"DELETE FROM products WHERE product_code='P001'", "INSERT INTO products VALUES('P001','ペン',120,1,1)",
                "INSERT INTO products VALUES('P003','余剰',1,0,1)", "UPDATE products SET price=121 WHERE product_code='P001'",
                "UPDATE inventory SET product_code='P003' WHERE product_code='P001'", "UPDATE inventory SET quantity=1 WHERE product_code='P002'",
                "UPDATE products SET version=2 WHERE product_code='P001'", "UPDATE sync_state SET catalog_version=2",
                "INSERT INTO orders VALUES('unexpected','P001',1,120,'CREATED')"};
            for(String fault:faults) {
                s.execute("SAVEPOINT inject"); s.execute(fault);
                assertFalse(CatalogCheck.differences(CatalogCheck.f1(),snapshot(c)).isEmpty(),fault);
                s.execute("ROLLBACK TO inject"); s.execute("RELEASE inject");
            }
            // 明示された削除済み行も在庫ゼロでなければ検出する。
            var expected=new LinkedHashMap<>(CatalogCheck.f1());
            expected.put("products",List.of(List.of("P001","ペン",120,1,1),List.of("P002","ノート",300,0,2)));
            expected.put("inventory",List.of(List.of("P001",5),List.of("P002",0)));
            s.execute("UPDATE products SET active=0,version=2 WHERE product_code='P002'");
            assertFalse(CatalogCheck.differences(expected,snapshot(c)).isEmpty());
        }
    }
    private Map<String,List<List<Object>>> snapshot(Connection c) throws SQLException {
        Map<String,List<List<Object>>> result=new LinkedHashMap<>();
        for(String table:List.of("products","inventory","orders","sync_state")) try(Statement s=c.createStatement();ResultSet rs=s.executeQuery("SELECT * FROM "+table+" ORDER BY 1")) {
            List<List<Object>> rows=new ArrayList<>(); int n=rs.getMetaData().getColumnCount();
            while(rs.next()) {List<Object> row=new ArrayList<>();for(int i=1;i<=n;i++) row.add(rs.getObject(i));rows.add(row);} result.put(table,rows);
        }
        return result;
    }
}
