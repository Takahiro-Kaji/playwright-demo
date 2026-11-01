const fixture = {
  catalogVersion: 1,
  products: [
    {
      productCode: "P001",
      name: "ペン",
      price: 120,
      active: true,
      quantity: 5,
    },
    {
      productCode: "P002",
      name: "ノート",
      price: 300,
      active: true,
      quantity: 2,
    },
  ],
};
import { bulkCatalog } from "../targets/sales/bulk-fixture.ts";

export function salesFixture(name: string) {
  if (name === "f1") return structuredClone(fixture);
  if (name === "f2") {
    const result = structuredClone(fixture);
    result.catalogVersion = 2;
    result.products[0].quantity = 3;
    return result;
  }
  if (name === "bulk1") return bulkCatalog(1);
  if (name === "bulk2") return bulkCatalog(2);
  throw Error("FIXTURE_INVALID");
}
if (process.argv[1]?.endsWith("/fixture.ts"))
  console.log(JSON.stringify(salesFixture(process.argv[2])));
