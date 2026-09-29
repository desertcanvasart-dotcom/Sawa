// The catalogue side of the "Edit day tour" page: for a tour_products row that
// a catalogue product is sold through, the product's own GoAhead minimum,
// maximum group and cut-off, and the published rate card's tiers.
import { pool } from "./db/index.js";
import { catalogueV2Enabled } from "./features.js";
import { mapCatalogueProduct, todayIn, isMissingCatalogueTables } from "./catalogue.js";
import { mapRate, rateInForce } from "./rates.js";

// Pure: shapes the rows into what the editor reads.
export function catalogueTourInfo({ enabled, productRow, rateRows = [], today }) {
  if (!enabled) return { enabled: false };
  if (!productRow) return { enabled: true, catalogue: null };
  const p = mapCatalogueProduct(productRow);
  const rate = rateInForce(rateRows.map(mapRate), today);
  return {
    enabled: true,
    catalogue: { id: p.id, code: p.code, title: p.title, goaheadMin: p.goaheadMin, maxGroup: p.maxGroup, cutoffHours: p.cutoffHours },
    rate: rate?.tiers?.length ? { version: rate.version, eurRate: rate.eurRate, tiers: rate.tiers } : null,
  };
}

export async function loadCatalogueTourInfo(tourProductId, { db = pool, now = Date.now() } = {}) {
  if (!catalogueV2Enabled()) return { enabled: false };
  try {
    const productRow = (await db.query("SELECT * FROM catalogue_products WHERE legacy_product_id = $1", [tourProductId])).rows[0];
    const rateRows = productRow
      ? (await db.query("SELECT * FROM catalogue_rate_versions WHERE product_id = $1 AND state = 'published'", [productRow.id])).rows
      : [];
    return catalogueTourInfo({ enabled: true, productRow, rateRows, today: todayIn(now) });
  } catch (e) {
    if (isMissingCatalogueTables(e)) return { enabled: true, catalogue: null };
    throw e;
  }
}
