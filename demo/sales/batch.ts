import { openDb, sync, validateCatalog } from './db.ts';
import { localUrl } from './server.ts';
export async function runBatch(dbPath:string, upstream:string) {
  const response=await fetch(new URL('/catalog',localUrl(upstream)),{signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok) throw Error('UPSTREAM_UNAVAILABLE');
  const catalog=validateCatalog(await response.json());
  const db=openDb(dbPath);try {sync(db,catalog);} finally {db.close();}
  return {status:'OK',catalogVersion:catalog.catalogVersion,count:catalog.products.length};
}
if(import.meta.main) {try {const r=await runBatch(process.env.SALES_DB!,process.env.UPSTREAM_URL!); console.log(JSON.stringify(r));}catch {console.error('SYNC_FAILED');process.exitCode=1;}}
