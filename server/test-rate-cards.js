// For the integration tests (066): a catalogue tour can be booked only while
// it has a rate card and the site-wide exchange rate is set. This gives every
// product without a card one tier covering its group sizes, with an operator
// fee of 0% and no selling price (so bookings keep the listing's price, as the
// tests were written for), and a manual exchange rate if there is none.
// Not a test file itself (no .test.js), so run-tests.js doesn't pick it up.
export async function makeToursBookable(db, { egpPerEur = 50 } = {}) {
  await db.query(
    `INSERT INTO catalogue_rate_cards (product_id, tiers, cost_lines, commission_pct, created_by, updated_by)
     SELECT c.id, jsonb_build_array(jsonb_build_object('from', c.goahead_min, 'to', c.max_group, 'priceEgp', NULL, 'operatorFeePct', 0)),
            '[]'::jsonb, 10, 'test', 'test'
       FROM catalogue_products c
      WHERE NOT EXISTS (SELECT 1 FROM catalogue_rate_cards r WHERE r.product_id = c.id)`);
  const has = (await db.query("SELECT 1 FROM fx_traveller_rates LIMIT 1")).rowCount;
  if (!has) {
    await db.query("INSERT INTO fx_traveller_rates (egp_per_eur, reason, note, set_by) VALUES ($1, 'manual', 'test: a rate so tours can be booked', 'test')", [egpPerEur]);
  }
}
