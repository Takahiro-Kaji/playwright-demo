import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
async function port():Promise<number> {return new Promise((ok,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as any).port;s.close(()=>ok(n));});});}
async function wait(url:string,p:ChildProcess) {for(let n=0;n<100;n++){if(p.exitCode!==null)throw Error('PROCESS_EXIT');try {await fetch(url);return;}catch {await new Promise(r=>setTimeout(r,50));}}throw Error('PROCESS_START_TIMEOUT');}
export async function harness(mode:'upstream'|'mock') {
 const id=randomUUID(), dir=resolve(`.local/sales-learning/${id}`);await mkdir(dir,{recursive:true});const db=dir+'/sales.sqlite';const catalog=dir+'/catalog.json';await writeFile(catalog,JSON.stringify({catalogVersion:1,products:[{productCode:'P001',name:'ペン',price:120,active:true,quantity:5},{productCode:'P002',name:'ノート',price:300,active:true,quantity:2}]}));const upPort=await port(),appPort=await port();const upstream=`http://127.0.0.1:${upPort}`,app=`http://127.0.0.1:${appPort}`,token=randomUUID()+randomUUID();const processes:ChildProcess[]=[];
 function run(args:string[],env:Record<string,string>) {const p=spawn(process.execPath,args,{env:{...process.env,...env},stdio:'ignore'});processes.push(p);return p;}
 const up=run(['demo/sales/server.ts',mode],{PORT:String(upPort),MOCK_TOKEN:token,SALES_CATALOG_FILE:catalog});await wait(upstream+'/catalog',up);
 const appProc=run(['demo/sales/server.ts','app'],{PORT:String(appPort),SALES_DB:db,UPSTREAM_URL:upstream});await wait(app+'/',appProc);
 async function batch() {return new Promise<number>((ok,no)=>{const p=run(['demo/sales/batch.ts'],{SALES_DB:db,UPSTREAM_URL:upstream});p.once('error',no);p.once('close',code=>ok(code??-1));});}
 async function status(value?:number) {const r=await fetch(upstream+'/admin/status',{method:value===undefined?'GET':'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify({status:value})})});if(!r.ok)throw Error('MOCK_CONTROL');return (await r.json() as any).status;}
 function query(sql:string,...args:any[]) {const d=new DatabaseSync(db);try {d.exec('PRAGMA foreign_keys=ON');return d.prepare(sql).all(...args);}finally{d.close();}}
 function execute(sql:string,...args:any[]) {const d=new DatabaseSync(db);try {d.exec('PRAGMA foreign_keys=ON');d.prepare(sql).run(...args);}finally{d.close();}}
 async function cleanup() {for(const p of processes)if(p.exitCode===null){p.kill('SIGTERM');await new Promise<void>(r=>{p.once('close',()=>r());setTimeout(r,2000);});}await rm(dir,{recursive:true,force:true});}
 return {app,upstream,db,dir,catalog,batch,status,query,execute,cleanup};
}
