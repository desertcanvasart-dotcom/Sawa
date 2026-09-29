// The catalogue side of the "Edit day tour" page: for a tour_products row that
// a catalogue product is sold through, the product's own GoAhead minimum,
// maximum group and cut-off, and its rate card's tiers (066: one per product).
import { pool } from "./db/index.js";
import { catalogueV2Enabled } from "./features.js";
import { mapCatalogueProduct, isMissingCatalogueTables } from "./catalogue.js";
import { mapRateCard } from "./rates.js";
import { currentTravellerRate } from "./fx.js";

// Pure: shapes the rows into what the editor reads.
// `eurRate` is the site-wide traveler rate (064), null while none is set.
export function catalogueTourInfo({ enabled, productRow, cardRow = null, eurRate = null }) {
  if (!enabled) return { enabled: false };
  if (!productRow) return { enabled: true, catalogue: null };
  const p = mapCatalogueProduct(productRow);
  const rate = mapRateCard(cardRow);
  return {
    enabled: true,
    catalogue: { id: p.id, code: p.code, title: p.title, goaheadMin: p.goaheadMin, maxGroup: p.maxGroup, cutoffHours: p.cutoffHours },
    rate: rate?.tiers?.length ? { eurRate, tiers: rate.tiers } : null,
  };
}

export async function loadCatalogueTourInfo(tourProductId, { db = pool } = {}) {
  if (!catalogueV2Enabled()) return { enabled: false };
  try {
    const productRow = (await db.query("SELECT * FROM catalogue_products WHERE legacy_product_id = $1", [tourProductId])).rows[0];
    const cardRow = productRow
      ? (await db.query("SELECT * FROM catalogue_rate_cards WHERE product_id = $1", [productRow.id])).rows[0] || null
      : null;
    const eurRate = (await currentTravellerRate(db))?.egpPerEur ?? null;
    return catalogueTourInfo({ enabled: true, productRow, cardRow, eurRate });
  } catch (e) {
    if (isMissingCatalogueTables(e)) return { enabled: true, catalogue: null };
    throw e;
  }
}
