import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import { mkdirSync, writeFileSync } from 'node:fs';
export default class SalesReporter implements Reporter {
  results: {title:string;status:string}[]=[];
  onTestEnd(test:TestCase,result:TestResult) {this.results.push({title:test.title,status:result.status});}
  onEnd(result:FullResult) {
    mkdirSync('.local/sales-learning-evidence',{recursive:true});
    const incomplete=this.results.some(r=>r.status==='skipped' || r.status==='interrupted');
    writeFileSync('.local/sales-learning-evidence/summary.json',JSON.stringify({status:incomplete?'incomplete':result.status,cases:this.results},null,2));
    if(incomplete) return {status:'failed' as const};
  }
}
