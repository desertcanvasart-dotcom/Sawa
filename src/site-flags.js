// What the page was served with: the inlined bootstrap payload, and the two deployment settings it carries
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import { readInlineData } from "./inline-data.js";

const INLINE_BOOTSTRAP = (() => {
  try {
    const data = readInlineData("sawa-bootstrap");
    // Guard the shape: a truncated or half-written payload should fall through
    // to the normal fetch rather than render an empty catalogue as if it were real.
    return data && Array.isArray(data.tourProducts) && Array.isArray(data.departures) ? data : null;
  } catch {
    return null;
  }
})();

// catalogue_v2 (model phase 1). One value per deployment, carried by the
// bootstrap payload; with it off the payload has no `catalogue` key and every
// page renders as before.
let CATALOGUE_V2 = INLINE_BOOTSTRAP?.catalogue?.enabled === true;
const catalogueV2 = () => CATALOGUE_V2;
const setCatalogueV2 = (on) => { CATALOGUE_V2 = on === true; };
// Cloudflare Turnstile's public site key from the bootstrap (null: no check).
let TURNSTILE_SITE_KEY = INLINE_BOOTSTRAP?.turnstileSiteKey || null;
const turnstileSiteKey = () => TURNSTILE_SITE_KEY;
const setTurnstileSiteKey = (key) => { TURNSTILE_SITE_KEY = key || null; };

export {
  INLINE_BOOTSTRAP, CATALOGUE_V2, catalogueV2, setCatalogueV2, TURNSTILE_SITE_KEY, turnstileSiteKey,
  setTurnstileSiteKey,
};
