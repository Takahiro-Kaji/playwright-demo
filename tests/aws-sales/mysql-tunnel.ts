import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import mysql from "mysql2/promise";
import { mysqlTls } from "../../aws/sales/tls.ts";

// Executed inside the selected app pod, without a shell or credentials in argv.
// stdout is reserved for the MySQL wire protocol. stderr must not be logged.
const proxy = `const net=require('node:net');const host=process.env.DB_HOST;if(!/^[a-z0-9.-]+\\.rds\\.amazonaws\\.com$/.test(host||''))process.exit(2);const s=net.connect(3306,host);s.on('error',()=>{process.exitCode=3;process.stdin.destroy()});process.stdin.pipe(s).pipe(process.stdout);process.stdin.on('end',()=>s.end());s.on('close',()=>process.stdin.destroy());`;

export type TunnelSettings = {
  runId: string;
  context: string;
  pod: string;
  dbHost: string;
  dbUser: string;
  dbPassword: string;
  caFile: string;
};

export function validateTunnelSettings(s: TunnelSettings) {
  if (!/^[a-f0-9]{32}$/.test(s.runId)) throw Error("RUN_ID_INVALID");
  if (
    !s.context ||
    s.context.startsWith("-") ||
    /[\s\x00-\x1f]/.test(s.context)
  )
    throw Error("CONTEXT_INVALID");
  if (!/^sales-app-[a-z0-9-]{1,50}$/.test(s.pod)) throw Error("POD_INVALID");
  if (!/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(s.dbHost))
    throw Error("DB_HOST_INVALID");
  if (!s.dbUser || !s.dbPassword || !s.caFile)
    throw Error("DB_CREDENTIALS_REQUIRED");
}

/** Each MySQL pool connection receives its own non-TTY exec process and tunnel.
 * Caller must first establish that this exact pod belongs to the run's app and
 * that its DB_HOST and DB_NAME match; validating names alone is not ownership. */
export function createTunnelPool(s: TunnelSettings) {
  validateTunnelSettings(s);
  return createPodPool(
    s,
    `sales-test-${s.runId}`,
    "app",
    `sales_test_${s.runId}`,
  );
}

/** Used only after Cluster ownership and Pod configuration verification. */
export function createPodPool(
  s: TunnelSettings,
  namespace: string,
  container: string,
  database?: string,
) {
  return mysql.createPool({
    host: s.dbHost,
    user: s.dbUser,
    password: s.dbPassword,
    database,
    ssl: mysqlTls(s.caFile),
    connectionLimit: 4,
    connectTimeout: 10000,
    stream: () => {
      const child = spawn(
        "kubectl",
        [
          "--context",
          s.context,
          "--namespace",
          namespace,
          "exec",
          "-i",
          s.pod,
          "-c",
          container,
          "--",
          "node",
          "-e",
          proxy,
        ],
        { stdio: ["pipe", "pipe", "ignore"], shell: false },
      );
      const stream = Duplex.from({
        readable: child.stdout as any,
        writable: child.stdin as any,
      });
      child.once("error", () =>
        stream.destroy(Error("DB_TUNNEL_START_FAILED")),
      );
      child.once("close", (code) => {
        if (code !== 0 && !stream.destroyed)
          stream.destroy(Error("DB_TUNNEL_FAILED"));
      });
      stream.once("close", () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
      });
      return stream;
    },
  });
}
