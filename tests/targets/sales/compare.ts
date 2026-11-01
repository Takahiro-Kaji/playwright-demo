import type { DatabaseSync } from 'node:sqlite';
type Expected = { productCode:string; name:string; price:number; active:boolean; quantity:number };
export function compareCatalog(db:DatabaseSync, expected:Expected[], productQuery='SELECT product_code,name,price,active FROM products', stockQuery='SELECT product_code,quantity FROM inventory') {
  const products=db.prepare(productQuery).all() as any[];
  const stock=db.prepare(stockQuery).all() as any[];
  const differences:string[]=[];
  function index(rows:any[], label:string) {
    const result=new Map<string,any>();
    for(const row of rows) {if(result.has(row.product_code)) differences.push(`${label}:duplicate:${row.product_code}`);else result.set(row.product_code,row);}
    return result;
  }
  const ps=index(products,'product'), inv=index(stock,'inventory');
  const activeExpected=new Set(expected.map(x=>x.productCode));
  for(const p of expected) {
    const actual=ps.get(p.productCode), quantity=inv.get(p.productCode);
    if(!actual) differences.push(`product:missing:${p.productCode}`);
    else if(actual.name!==p.name || actual.price!==p.price || actual.active!==Number(p.active)) differences.push(`product:value:${p.productCode}`);
    if(!quantity) differences.push(`inventory:missing:${p.productCode}`);
    else if(quantity.quantity!==p.quantity) differences.push(`inventory:value:${p.productCode}`);
  }
  for(const [key,p] of ps) if(!activeExpected.has(key) && p.active) differences.push(`product:extra:${key}`);
  for(const [key] of inv) if(!ps.has(key)) differences.push(`inventory:orphan:${key}`);
  return differences;
}
