// DIR-20.1 — the authoritative GoAhead transition, on its own.
//
// This lived inside server/app.js, a 2,000-line route file that imports the
// Supabase client at load. Nothing could exercise the transition without
// standing up authentication, which is why the moment the whole site is built
// around had never been rehearsed against a database.
//
// Same lesson as scripts/smoke-routes.js in DIR-13: the check that had no
// proven-fires test was the one that could not be imported. A thing that cannot
// be run in isolation does not get run.
import { DEFAULT_GO_AHEAD } from "../shared/group-size.js";
import { recordGoAhead } from "./goahead-alert.js";

export async function refreshStatus(c, departureId) {
  const dep = await c.query(`SELECT * FROM departures WHERE id=$1`, [departureId]);
  const row = dep.rows[0];
  // pending_review must not auto-advance from pledge counts — only an admin
  // approval moves it to 'open' (traveler-initiated departures, Phase A).
  //
  // BBBB1.1 — `minimum_reached` is in this list now. Once a date reaches
  // GoAhead it runs, so nothing recomputes it downward.
  //
  // Without this, the sequence was: four seats -> minimum_reached, travellers
  // told it is confirmed; one cancels -> refreshStatus writes `open` again;
  // past the confirm deadline the unattended job selects it (it queries
  // WHERE status = 'open') and CANCELS A CONFIRMED DEPARTURE, emailing everyone
  // that it will not run. The cancellation email is already built and live.
  if (["pending_review", "minimum_reached", "supplier_confirmed", "closed", "cancelled"].includes(row.status)) return;
  // Cancelled pledges have freed their seats — exclude them from the count.
  const seats = (await c.query(
    `SELECT COALESCE(SUM(seats),0) AS s FROM pledges WHERE departure_id=$1 AND status <> 'cancelled'`,
    [departureId]
  )).rows[0].s;
  const required = Math.max(1, Number(row.min_seats) || DEFAULT_GO_AHEAD);
  const status = Number(seats) >= required ? "minimum_reached" : "open";
  await c.query(`UPDATE departures SET status=$1 WHERE id=$2`, [status, departureId]);

  // DIR-20.1 — the GoAhead moment, recorded where it actually happens.
  //
  // This function has four callers under three different transaction
  // boundaries. A trigger in any route handler would fire for that route and no
  // other, which is exactly the mirror's defect: three writers told Autoura and
  // the fourth did not. Here it commits with the status change or not at all.
  //
  // The email is sent by a job reading the queue this row creates (20.3). It is
  // deliberately NOT sent from inside this transaction: a send that succeeded
  // before a rollback would announce a departure that never confirmed.
  if (status === "minimum_reached" && row.status !== "minimum_reached") {
    await recordGoAhead(c, departureId, { seats: Number(seats), required, from: row.status });
  }
}
