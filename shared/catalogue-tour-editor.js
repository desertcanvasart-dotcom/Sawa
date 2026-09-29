// What the "Edit day tour" page shows for a tour that is a catalogue product
// (catalogue_v2, 29 Sep 2026). The catalogue and the rate card own the price,
// deposit, cut-off, minimum and group size, so the editor shows them read-only
// and hides the legacy fields that used to set them.
//
// `info` is what GET /api/admin/tour-products/:id/catalogue returns:
//   { enabled: false }                          flag off: the legacy editor, unchanged
//   { enabled: true, catalogue: null }          not a catalogue product: unchanged
//   { enabled: true, catalogue: {...}, rate }   a catalogue product
import { tierPriceRows, tierPriceSummary } from "./pool-model.js";
import { cutoffLabel } from "./booking-policy.js";

export const NO_RATE_CARD = "No published rate card: this tour can't be booked";

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
  const rows = tierPriceRows(tiers, info.rate?.eurRate);
  const summary = info.rate ? tierPriceSummary(tiers, info.rate.eurRate) : null;
  return {
    hasRate: !!summary,
    warning: summary ? null : NO_RATE_CARD,
    rows: summary ? rows : [],
    summary,
    facts: [
      { label: "GoAhead minimum", value: `${c.goaheadMin} travelers` },
      { label: "Maximum group", value: `${c.maxGroup} travelers` },
      { label: "Booking cut-off", value: cutoffLabel(c.cutoffHours, "hours") },
    ],
    rateCardLabel: "Edit prices in Rate card",
  };
}
