// The currency every price on this site is quoted in. One declaration.
//
// ============================================================================
// WHY THIS EXISTS
// ============================================================================
//
// The site quoted in US dollars, and it said so in forty-odd places typed by
// hand: `'$'+price+' USD / person'` in five destination pages and three boards,
// `"$" + n.toLocaleString()` in three dashboards and the operator emails,
// `priceCurrency: "USD"` in the schema.org graph, "All prices are in US dollars
// (USD)" in the Terms, on /goahead-promise and in the booking summary, and a
// bare "$0" on four marketing pages.
//
// That is the exact shape this project has been dismantling everywhere else —
// the group-size numbers, the slug, the board rules — where one fact lives in
// twenty files and the twentieth is the one that drifts. A price with the wrong
// currency on it is not a cosmetic drift: it is a number a traveller commits to.
//
// So the symbol, the code and the prose form all live here, and everything that
// renders money reads them.
//
// The STATIC pages cannot import this — they are hand-written documents served
// off disk, the same constraint that produced site/assets/rules.js. They carry
// the glyph literally, and `server/currency.test.js` sweeps every copy surface
// for a dollar sign or a "USD" so a re-introduced one fails the build rather
// than reaching a traveller.
//
// Deliberately dependency-free: this is imported into the browser bundle and
// into server modules that touch a price, the same constraint as group-size.js.

// ISO 4217. This is what goes in structured data and in any payload that leaves
// the system — schema.org offers, the Autoura inventory feed — where a machine
// reads it and a symbol would be ambiguous.
export const CURRENCY = "EUR";

// What a traveller sees against a number.
export const CURRENCY_SYMBOL = "€";

// The prose form, for the one sentence per surface that states the currency
// outright: "All amounts are in euros (EUR)." Written as a noun phrase so it
// drops into a sentence as a unit — same discipline as shared/site-copy.js,
// which learned it from "24/7" reaching six places in four grammars.
export const CURRENCY_PROSE = "euros (EUR)";
