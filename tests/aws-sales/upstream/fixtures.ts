import { bulkCatalog } from "../../targets/sales/bulk-fixture.ts";

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
if (process.argv[1]?.endsWith("/upstream/fixtures.ts"))
  console.log(JSON.stringify(salesFixture(process.argv[2])));

export function expectedFixture(name: string) {
  const f = salesFixture(name);
  return {
    products: f.products.map((p, i) => ({
      ...p,
      version: name === "bulk2" ? 2 : name === "f2" && i === 0 ? 2 : 1,
    })),
    deleted: [],
    catalogVersion: f.catalogVersion,
    orders: [],
  };
}
