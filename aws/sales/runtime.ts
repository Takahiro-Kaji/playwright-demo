import http from 'node:http';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { page, script, upstreamServer } from '../../demo/sales/server.ts';
import { syncSales, products, orderSales } from './db.ts';
import { mysqlTls } from './tls.ts';

function required(k: string) { const v = process.env[k]; if (!v) throw Error(`${k}_REQUIRED`); return v; }
function upstream() {
  const url = new URL(required('UPSTREAM_URL'));
  if (url.protocol !== 'http:' || url.username || url.password || url.hostname !== 'sales-upstream' || url.search || url.hash || url.pathname !== '/') throw Error('UPSTREAM_URL_INVALID');
  return url;
}
function pool() {
  return mysql.createPool({ host:required('DB_HOST'), user:required('DB_USER'), password:required('DB_PASSWORD'), database:required('DB_NAME'), ssl:mysqlTls(required('DB_CA_FILE')), connectionLimit:4, connectTimeout:7000, charset:'utf8mb4' });
}
async function catalog() {
  const r = await fetch(new URL('/catalog', upstream()), {signal:AbortSignal.timeout(5000),redirect:'error'});
  if (!r.ok) throw Error('UPSTREAM_UNAVAILABLE');
  return r.json();
}
function json(res: http.ServerResponse,status: number,data: unknown) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(data)); }
async function body(req: http.IncomingMessage) { let value=''; for await (const chunk of req) { value += chunk; if (Buffer.byteLength(value)>8192) throw Error('TOO_LARGE'); } return JSON.parse(value); }
async function main() {
  const mode = process.argv[2];
  if (mode === 'schema') { const db=pool(); try { for (const sql of readFileSync('aws/sales/schema.sql','utf8').split(';').map(s => s.trim()).filter(Boolean)) await db.query(sql); } finally { await db.end(); } return; }
  if (mode === 'batch') { const db=pool(); try { console.log(JSON.stringify(await syncSales(db,await catalog()))); } finally { await db.end(); } return; }
  const port = Number(required('PORT'));
  if (!Number.isInteger(port) || port<1 || port>65535) throw Error('PORT_INVALID');
  if (mode === 'upstream' || mode === 'mock') { upstreamServer(mode === 'mock' ? required('MOCK_TOKEN') : '',mode === 'mock').listen(port,'0.0.0.0'); return; }
  if (mode !== 'app') throw Error('MODE_INVALID');
  const db = pool(); upstream();
  http.createServer(async (req,res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') { await db.query('SELECT 1'); return json(res,200,{ready:true}); }
      if (req.method === 'GET' && req.url === '/') { res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}); return res.end(page); }
      if (req.method === 'GET' && req.url === '/app.js') { res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}); return res.end(script); }
      if (req.method === 'GET' && req.url === '/api/availability') { try { await catalog(); return json(res,200,{available:true}); } catch { return json(res,502,{error:'UPSTREAM_UNAVAILABLE'}); } }
      if (req.method === 'GET' && req.url === '/api/products') { const r=await products(db); return json(res,r.status,r.body); }
      if (req.method === 'POST' && req.url === '/api/orders') { let input; try { input=await body(req); } catch { return json(res,400,{error:'INVALID_REQUEST'}); } const r=await orderSales(db,input); return json(res,r.status,r.body); }
      return json(res,404,{error:'NOT_FOUND'});
    } catch { return json(res,500,{error:'INTERNAL_ERROR'}); }
  }).listen(port,'0.0.0.0');
}
main().catch(() => { console.error('SALES_START_OR_SYNC_FAILED'); process.exitCode=1; });
