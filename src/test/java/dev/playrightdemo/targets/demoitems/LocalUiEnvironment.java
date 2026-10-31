package dev.playrightdemo.targets.demoitems;

import dev.playrightdemo.foundation.UiEnvironment;
import dev.playrightdemo.foundation.LocalMysql;

import dev.playrightdemo.demo.app.DemoApp;
import dev.playrightdemo.demo.statusmock.StatusMock;
import java.net.URI;
import java.sql.Connection;
import java.util.List;
import javax.sql.DataSource;

/** Owns only the loopback servers and disposable MySQL it starts. */
public final class LocalUiEnvironment implements UiEnvironment {
    private static final String TOKEN="local-"+"x".repeat(48);
    private LocalMysql mysql; private StatusMock a,b; private DemoApp appA,appB;
    private LocalUiEnvironment() {}
    public static LocalUiEnvironment start(boolean wrongStatus, boolean asymmetric) throws Exception {
        LocalUiEnvironment e=new LocalUiEnvironment();
        try {
            e.mysql=LocalMysql.start();
            e.a=new StatusMock("local-a",TOKEN,200).start("127.0.0.1",0,0);
            e.b=new StatusMock("local-b",TOKEN,asymmetric?429:200).start("127.0.0.1",0,0);
            e.appA=new DemoApp("local-a",e.a.businessUri(),e.mysql.dataSource()).start("127.0.0.1",0);
            e.appB=new DemoApp("local-b",e.b.businessUri(),e.mysql.dataSource()).start("127.0.0.1",0);
            try(Connection c=e.mysql.dataSource().getConnection(); var s=c.createStatement()) {
                s.execute("CREATE TABLE items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, test_key VARCHAR(64) NOT NULL UNIQUE, status VARCHAR(32) NOT NULL)");
                if(wrongStatus) s.execute("CREATE TRIGGER wrong_status BEFORE INSERT ON items FOR EACH ROW SET NEW.status = 'INJECTED_STATUS'");
            }
            return e;
        } catch(Exception failure) { try { e.close(); } catch(Exception cleanup) { failure.addSuppressed(cleanup); } throw failure; }
    }
    public List<Target> targets() { return List.of(new Target("local-a",appA.uri(),a.businessUri(),a.adminUri()),new Target("local-b",appB.uri(),b.businessUri(),b.adminUri())); }
    public URI baseUri() { return appA.uri(); }
    public DataSource dataSource() { return mysql.dataSource(); }
    public String mockToken() { return TOKEN; }
    public boolean disposable() { return true; }
    public void setCleanupDeadlineNanos(long deadline) { mysql.setCleanupDeadlineNanos(deadline); }
    public void close() throws Exception {
        Exception failure=null;
        for(AutoCloseable item:new AutoCloseable[]{appB,appA,b,a,mysql}) if(item!=null) try { item.close(); } catch(Exception e) { if(failure==null) failure=e; else failure.addSuppressed(e); }
        if(failure!=null) throw failure;
    }
}
