#!/bin/bash
set +x
set -euo pipefail
# Run from the repository root with local mysqld, mysql, mysqladmin and openssl.
# All credentials and keys are disposable, and the server listens only on loopback.
mysql_bin=${MYSQL_BIN:-mysql}
mysqladmin_bin=${MYSQLADMIN_BIN:-mysqladmin}
mysqld_bin=${MYSQLD_BIN:-mysqld}
umask 077
scratch=$(mktemp -d /tmp/probe-tls.XXXXXX)
server_pid=''
finish() { if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi; rm -rf "$scratch"; }
trap finish EXIT
mkdir "$scratch/data"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=TestCA -keyout "$scratch/ca.key" -out "$scratch/ca.pem" > /dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=good.example.rds.amazonaws.com -keyout "$scratch/server.key" -out "$scratch/server.csr" > /dev/null 2>&1
printf 'subjectAltName=DNS:good.example.rds.amazonaws.com\nextendedKeyUsage=serverAuth\n' > "$scratch/ext.cnf"
openssl x509 -req -in "$scratch/server.csr" -CA "$scratch/ca.pem" -CAkey "$scratch/ca.key" -CAcreateserial -days 1 -extfile "$scratch/ext.cnf" -out "$scratch/server.crt" > /dev/null 2>&1
"$mysqld_bin" --no-defaults --initialize-insecure --datadir="$scratch/data" --log-error="$scratch/init.log" || { cat "$scratch/init.log"; exit 1; }
port=$(node -e "const n=require('net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})")
"$mysqld_bin" --no-defaults --datadir="$scratch/data" --socket="$scratch/mysql.sock" --pid-file="$scratch/mysql.pid" --port="$port" --bind-address=127.0.0.1 --ssl-ca="$scratch/ca.pem" --ssl-cert="$scratch/server.crt" --ssl-key="$scratch/server.key" --log-error="$scratch/mysql.log" > /dev/null 2>&1 &
server_pid=$!
for n in $(seq 1 90); do if "$mysqladmin_bin" --no-defaults --socket="$scratch/mysql.sock" -u root ping > /dev/null 2>&1; then break; fi; if ! kill -0 "$server_pid" 2>/dev/null; then echo 'temporary MySQL failed to start' >&2; exit 1; fi; sleep 1; done
"$mysqladmin_bin" --no-defaults --socket="$scratch/mysql.sock" -u root ping > /dev/null
probe_password=$(openssl rand -hex 24)
if ! printf "CREATE DATABASE integration_demo;\nCREATE USER 'probe'@'localhost' IDENTIFIED BY '%s' REQUIRE SSL;\nGRANT SELECT ON integration_demo.* TO 'probe'@'localhost';\n" "$probe_password" | "$mysql_bin" --no-defaults --socket="$scratch/mysql.sock" -u root > /dev/null 2>&1; then
  echo 'temporary MySQL setup failed' >&2
  exit 1
fi
PROBE_TEST_CA="$scratch/ca.pem" PROBE_TEST_PORT="$port" PROBE_TEST_PASSWORD="$probe_password" node --input-type=module <<'JS'
import dns from 'node:dns';
import mysql from 'mysql2/promise';
import { mysqlTls } from './aws/sales/tls.ts';
const original = dns.lookup;
dns.lookup = function(host, options, callback) {
  if (host.endsWith('.example.rds.amazonaws.com')) {
    const done = typeof options === 'function' ? options : callback;
    return process.nextTick(() => options?.all ? done(null, [{address:'127.0.0.1', family:4}]) : done(null, '127.0.0.1', 4));
  }
  return original.apply(this, arguments);
};
try {
const config = {host:'good.example.rds.amazonaws.com',user:'probe',password:process.env.PROBE_TEST_PASSWORD,database:'integration_demo',ssl:mysqlTls(process.env.PROBE_TEST_CA)};
const connection = await mysql.createConnection({...config,port:Number(process.env.PROBE_TEST_PORT)});
const [result] = await connection.query("SHOW STATUS LIKE 'Ssl_cipher'");
if (!result[0]?.Value) throw Error('TLS_NOT_ACTIVE');
await connection.end();
console.log('Trusted CA and matching hostname: TLS connection succeeded');
let rejected = false;
try { const bad = await mysql.createConnection({...config,host:'wrong.example.rds.amazonaws.com',port:Number(process.env.PROBE_TEST_PORT)}); await bad.end(); }
catch (error) { if (error.code !== 'HANDSHAKE_SSL_ERROR' || !/Hostname\/IP does not match certificate/i.test(error.message)) throw Error('UNEXPECTED_TLS_FAILURE'); rejected = true; }
if (!rejected) throw Error('HOSTNAME_MISMATCH_ACCEPTED');
console.log('Trusted CA and mismatched hostname: rejected by certificate hostname validation (HANDSHAKE_SSL_ERROR)');
} catch { console.error('TLS_TEST_FAILED'); process.exitCode = 1; }
JS
TEST_MYSQL_SOCKET="$scratch/mysql.sock" TEST_MYSQL_CA="$scratch/ca.pem" node --test aws/tests/mysql-probe.test.ts
