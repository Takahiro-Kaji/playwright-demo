import { fixture } from '../../demo/sales/server.ts';
import { bulkCatalog } from '../targets/sales/bulk-fixture.ts';

export function salesFixture(name: string) {
  if (name === 'f1') return structuredClone(fixture);
  if (name === 'f2') {
    const result = structuredClone(fixture);
    result.catalogVersion = 2;
    result.products[0].quantity = 3;
    return result;
  }
  if (name === 'bulk1') return bulkCatalog(1);
  if (name === 'bulk2') return bulkCatalog(2);
  throw Error('FIXTURE_INVALID');
}
if (import.meta.main) console.log(JSON.stringify(salesFixture(process.argv[2])));
