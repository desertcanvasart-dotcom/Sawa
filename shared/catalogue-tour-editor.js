// What the "Edit day tour" page shows for a tour that is a catalogue product
// (catalogue_v2, 29 Sep 2026). The catalogue and the rate card own the price,
// deposit, cut-off, minimum and group size, so the editor shows them read-only
// and hides the legacy fields that used to set them.
//
// `info` is what GET /api/admin/tour-products/:id/catalogue returns:
//   { enabled: false }                          flag off: the legacy editor, unchanged
//   { enabled: true, catalogue: null }          not a catalogue product: unchanged
//   { enabled: true, catalogue: {...}, rate }   a catalogue product
import { tierPriceRows, tierPriceSummary, tierEgp } from "./pool-model.js";
import { cutoffLabel } from "./booking-policy.js";

export const NO_RATE_CARD = "No published rate card: this tour can't be booked";
export const NO_EXCHANGE_RATE = "Exchange rate not set";

// The legacy fields a catalogue product hides.
export const LEGACY_PRICING_FIELDS = [
  "GoAhead price", "Break price", "per-group-size prices", "Use the sliding price instead",
  "Deposit %", "Booking cutoff", "Operating company",
];

export const isCatalogueTour = (info) => !!(info && info.enabled && info.catalogue);

// The read-only view: null for a legacy tour (render nothing new).
export function catalogueTourView(info) {
  if (!isCatalogueTour(info)) return null;
  const c = info.catalogue;
  const tiers = info.rate?.tiers || [];
  const eurRate = info.rate?.eurRate ?? null;
  // No site-wide exchange rate: no euro price, even for a EUR-priced card.
  const rows = eurRate == null ? [] : tierPriceRows(tiers, eurRate);
  const summary = info.rate && eurRate != null ? tierPriceSummary(tiers, eurRate) : null;
  // One price (the default): "€54 per person", with how it is worked out shown beside it.
  const eurPriced = tiers.length === 1 && tiers[0].priceEur != null;
  const single = summary && tiers.length === 1
    ? { eur: rows[0].eur, egp: eurPriced ? tierEgp(tiers[0], eurRate) : tiers[0].priceEgp, eurRate, eurPriced } : null;
  return {
    hasRate: !!summary,
    single,
    // Phase 7: a EUR price is what travelers pay; its EGP is worked out from it.
    howWorked: !single ? null : eurPriced
      ? `Set in EUR in the Rate card; ≈ EGP ${Number(single.egp).toLocaleString("en-US")} at the exchange rate ${eurRate}`
      : `EGP ${Number(single.egp).toLocaleString("en-US")} ÷ exchange rate ${single.eurRate}, rounded up`,
    // A rate card with prices but no site-wide traveler rate: no euro price to show.
    warning: summary ? null : info.rate && info.rate.eurRate == null ? NO_EXCHANGE_RATE : NO_RATE_CARD,
    rows: summary ? rows : [],
    summary,
    facts: [
      { label: "GoAhead minimum", value: `${c.goaheadMin} travelers` },
      { label: "Maximum group", value: `${c.maxGroup} travelers` },
      { label: "Booking cut-off", value: cutoffLabel(c.cutoffHours, "hours") },
    ],
    rateCardLabel: tiers.length > 1 ? "Edit prices in Rate card" : "Edit price in Rate card",
  };
}
