import { readFileSync } from 'node:fs';

/** Verify both the CA chain and the RDS endpoint hostname. */
export function mysqlTls(caFile: string) {
  return {ca:readFileSync(caFile), rejectUnauthorized:true, verifyIdentity:true} as const;
}
