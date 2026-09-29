// The operator fee for ONE departure (29 Sep 2026, catalogue_v2).
//
// The rate card sets the fee per product, as a percentage of operating cost. An
// admin can set a different percentage for a single departure, with a reason,
// until the operator's offer is acknowledged. After that it is locked. It changes
// that departure's entitlement and pool and nothing else: every other departure
// of the product, and the rate card, are untouched. The statements and the margin
// report show the percentage actually used and mark an override.
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError } from "./catalogue.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));

export const FEE_LOCKED_MESSAGE = "The operator has acknowledged this departure's offer, so its operator fee is locked.";

// pct: a number 0–100 to set, or null to go back to the rate card's fee. A reason
// is required for either. Returns { from, to } for the audit log.
export async function setOperatorFeeOverride(db, { departureId, pct, reason, by }) {
  const why = String(reason || "").trim();
  if (!why) throw new CatalogueError(422, "Say why: a reason is required for changing an operator fee.");
  const clearing = pct == null || pct === "";
  const value = clearing ? null : Number(pct);
  if (!clearing && !(Number.isFinite(value) && value >= 0 && value <= 100)) {
    throw new CatalogueError(422, "The operator fee is a percentage from 0 to 100.");
  }
  return inTx(db, async (c) => {
    const cd = (await c.query("SELECT * FROM catalogue_departures WHERE id = $1 FOR UPDATE", [departureId])).rows[0];
    if (!cd) throw new CatalogueError(404, "Departure not found.");
    const acknowledged = (await c.query(
      "SELECT 1 FROM catalogue_assignments WHERE departure_id = $1 AND state = 'acknowledged'", [departureId])).rowCount > 0;
    if (acknowledged) throw new CatalogueError(409, FEE_LOCKED_MESSAGE);
    const from = cd.operator_fee_pct_override == null ? null : Number(cd.operator_fee_pct_override);
    await c.query(
      `UPDATE catalogue_departures SET operator_fee_pct_override = $2, operator_fee_override_reason = $3,
              operator_fee_override_by = $4, operator_fee_override_at = now() WHERE id = $1`,
      [departureId, value, clearing ? null : why, clearing ? null : by || "admin"]);
    return { from, to: value, reason: why, departureNo: Number(cd.departure_no) || 1 };
  });
}
