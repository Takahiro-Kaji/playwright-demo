package dev.playrightdemo.targets.reference;

import dev.playrightdemo.demo.referencesource.ReferenceSource;
import dev.playrightdemo.foundation.LocalMysql;
import dev.playrightdemo.process.OwnedProcesses;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** Local reference-demo resources shared by batch and cross scenarios. */
public final class ReferenceEnvironment implements AutoCloseable {
        final Path creds; public final LocalMysql mysql; public final ReferenceSource source; final Map<String,Object> summary; private java.util.function.BooleanSupplier cleanupGuard=() -> true; public final OwnedProcesses children = new OwnedProcesses();
        private ReferenceEnvironment(Path creds, LocalMysql mysql, ReferenceSource source, Map<String,Object> summary) { this.creds=creds; this.mysql=mysql; this.source=source; this.summary=summary; }
        public static ReferenceEnvironment start(Path creds, List<?> records, Map<String,Object> summary) throws Exception {
            LocalMysql mysql = null; ReferenceSource source = null;
            try { mysql=LocalMysql.start(); source=new ReferenceSource(records).start("127.0.0.1",0); return new ReferenceEnvironment(creds,mysql,source,summary); }
            catch(Exception e) { if(source!=null) source.close(); if(mysql!=null) try { mysql.close(); } catch(Exception cleanup) { e.addSuppressed(cleanup); } Files.deleteIfExists(creds); throw e; }
        }
        public void setCleanupGuard(java.util.function.BooleanSupplier guard) { this.cleanupGuard=guard; }
        public void close() throws Exception {
            // Do not destroy the database or credentials while the sync process might still write.
            Exception failure=null;
            try { children.close(); } catch(Exception e) { failure=e; }
            if (!children.allStopped() || !cleanupGuard.getAsBoolean()) { summary.put("environmentCleanup","failed"); throw failure != null ? failure : new IllegalStateException("Owned activity still running; database retained"); }
            boolean interrupted=Thread.interrupted();
            try { source.close(); } catch(Exception e) { if(failure==null) failure=e; else failure.addSuppressed(e); }
            try { mysql.close(); } catch(Exception e) { if(failure==null) failure=e; else failure.addSuppressed(e); }
            try { Files.deleteIfExists(creds); } catch(Exception e) { if(failure==null) failure=e; else failure.addSuppressed(e); }
            if(interrupted) Thread.currentThread().interrupt();
            summary.put("environmentCleanup",failure==null?"completed":"failed");
            if(failure!=null) throw failure;
        }
    }
