/** 同期中観測に使う固定合成データを作る。件数、bulkCatalogの順に読む。 */
/** Fixed, synthetic data only for CROSS-01; generation does not inspect the system. */
export const BULK_COUNT = 3000;
/**
 * 指定versionの固定合成カタログを返す。1は旧、2は新。実測値から期待を作らない。
 * 想定した1または2では通常例外を送出しない。
 */
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
