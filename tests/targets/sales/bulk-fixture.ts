/** Fixed, synthetic data only for CROSS-01; generation does not inspect the system. */
export const BULK_COUNT = 3000;
export function bulkCatalog(version: 1 | 2) {
  return {
    catalogVersion: version,
    products: Array.from({ length: BULK_COUNT }, (_, index) => ({
      productCode: `S${String(index + 1).padStart(4, "0")}`,
      name: `学習商品${String(index + 1).padStart(4, "0")}`,
      price: 100 + index,
      active: true,
      quantity: version === 1 ? 5 : 3,
    })),
  };
}
