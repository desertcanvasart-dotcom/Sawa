// The roster (model phase 2): which operator runs which product on which date.
//
// A month is planned as operator × product × weekday, built into dated
// entries, adjusted date by date, and published by the 15th of the month
// before. Operators see only their own published entries. Swaps go from one
// active operator to another for the same product and date, and need an
// admin's approval. Every write goes through rosterEligibility: only active
// operators approved for the product.
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import { rosterEligibility } from "./operators.js";
import { datesForRule, weekdayOf } from "../shared/catalogue.js";
import { rosterDeadline, datesInMonth, monthOf } from "../shared/operators.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ""));

function checkMonth(month) {
  if (!isMonth(month)) throw new CatalogueError(422, "Use a month like 2026-11.");
  return month;
}

async function ensureMonth(c, month) {
  await c.query("INSERT INTO roster_months (month) VALUES ($1) ON CONFLICT (month) DO NOTHING", [month]);
  return (await c.query("SELECT * FROM roster_months WHERE month = $1", [month])).rows[0];
}

const mapEntry = (r) => ({
  id: Number(r.id), month: r.month, productId: Number(r.product_id), date: ymd(r.date),
  operatorId: Number(r.operator_id), source: r.source, updatedBy: r.updated_by, updatedAt: r.updated_at,
  operatorName: r.legal_name, operatorStatus: r.operator_status,
});

// Everything the planning screen shows for a month.
export async function rosterMonth(db, month, now = Date.now()) {
  checkMonth(month);
  const [m, lines, entries, swaps] = await Promise.all([
    db.query("SELECT * FROM roster_months WHERE month = $1", [month]),
    db.query("SELECT * FROM roster_plan_lines WHERE month = $1 ORDER BY product_id, weekday", [month]),
    db.query(`SELECT e.*, o.legal_name, o.status AS operator_status FROM roster_entries e JOIN operators o ON o.id = e.operator_id
               WHERE e.month = $1 ORDER BY e.date, e.product_id`, [month]),
    db.query(`SELECT s.*, e.date, e.product_id FROM roster_swaps s JOIN roster_entries e ON e.id = s.entry_id
               WHERE e.month = $1 ORDER BY s.requested_at DESC`, [month]),
  ]);
  const deadline = rosterDeadline(month);
  return {
    month,
    state: m.rows[0]?.state || "draft",
    publishedAt: m.rows[0]?.published_at || null,
    publishedBy: m.rows[0]?.published_by || null,
    deadline,
    late: (m.rows[0]?.state !== "published") && todayIn(now) > deadline,
    plan: lines.rows.map((l) => ({ productId: Number(l.product_id), weekday: l.weekday, operatorId: Number(l.operator_id) })),
    entries: entries.rows.map(mapEntry),
    swaps: swaps.rows.map((s) => ({
      id: Number(s.id), entryId: Number(s.entry_id), date: ymd(s.date), productId: Number(s.product_id),
      fromOperatorId: Number(s.from_operator_id), toOperatorId: Number(s.to_operator_id), note: s.note,
      requestedBy: s.requested_by, requestedAt: s.requested_at, state: s.state, decidedBy: s.decided_by, decidedAt: s.decided_at,
    })),
  };
}

// Plan one product weekday (operatorId null clears it).
export async function setPlanLine(db, { month, productId, weekday, operatorId }) {
  checkMonth(month);
  const wd = Number(weekday);
  if (!(wd >= 0 && wd <= 6)) throw new CatalogueError(422, "Weekday must be 0 (Sunday) to 6 (Saturday).");
  return inTx(db, async (c) => {
    await ensureMonth(c, month);
    if (operatorId == null) {
      await c.query("DELETE FROM roster_plan_lines WHERE month = $1 AND product_id = $2 AND weekday = $3", [month, productId, wd]);
      return null;
    }
    const ok = await rosterEligibility(c, operatorId, productId);
    if (!ok.ok) throw new CatalogueError(422, ok.reason);
    await c.query(
      `INSERT INTO roster_plan_lines (month, product_id, weekday, operator_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (month, product_id, weekday) DO UPDATE SET operator_id = EXCLUDED.operator_id`,
      [month, productId, wd, operatorId]);
    return { month, productId, weekday: wd, operatorId };
  });
}

// The dates a product runs in a month: its calendar rules, plus any catalogue
// departure already on the calendar that month.
async function productDatesInMonth(c, productId, month) {
  const days = datesInMonth(month);
  const from = days[0];
  const to = days[days.length - 1];
  const rules = (await c.query("SELECT * FROM catalogue_calendar_rules WHERE product_id = $1", [productId])).rows.map((r) => ({
    kind: r.kind, weekdays: r.weekdays ? r.weekdays.map(Number) : null, intervalWeeks: r.interval_weeks,
    anchorDate: ymd(r.anchor_date), dates: r.dates ? r.dates.map(ymd) : null, activeFrom: ymd(r.active_from), activeTo: ymd(r.active_to),
  }));
  const set = new Set(rules.flatMap((r) => datesForRule(r, from, to)));
  const deps = await c.query("SELECT date FROM catalogue_departures WHERE product_id = $1 AND date BETWEEN $2 AND $3", [productId, from, to]);
  for (const d of deps.rows) set.add(ymd(d.date));
  return [...set].sort();
}

// Turn the plan into dated entries. Date overrides and approved swaps are kept;
// plan entries are rewritten to match the plan.
export async function buildMonth(db, month, by) {
  checkMonth(month);
  return inTx(db, async (c) => {
    await ensureMonth(c, month);
    const lines = (await c.query("SELECT * FROM roster_plan_lines WHERE month = $1", [month])).rows;
    const byProduct = new Map();
    for (const l of lines) {
      const pid = Number(l.product_id);
      if (!byProduct.has(pid)) byProduct.set(pid, new Map());
      byProduct.get(pid).set(l.weekday, Number(l.operator_id));
    }
    await c.query("DELETE FROM roster_entries WHERE month = $1 AND source = 'plan'", [month]);
    let written = 0;
    const skipped = [];
    for (const [pid, weekdays] of byProduct) {
      for (const date of await productDatesInMonth(c, pid, month)) {
        const op = weekdays.get(weekdayOf(date));
        if (!op) continue;
        const ok = await rosterEligibility(c, op, pid);
        if (!ok.ok) { skipped.push({ productId: pid, date, reason: ok.reason }); continue; }
        const r = await c.query(
          `INSERT INTO roster_entries (month, product_id, date, operator_id, source, updated_by)
           VALUES ($1, $2, $3, $4, 'plan', $5) ON CONFLICT (product_id, date) DO NOTHING`,
          [month, pid, date, op, by]);
        written += r.rowCount;
      }
    }
    return { written, skipped };
  });
}

// Put one operator on one date (null removes the entry).
export async function overrideEntry(db, { productId, date, operatorId, by }) {
  const day = ymd(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new CatalogueError(422, "Use a date like 2026-11-13.");
  const month = monthOf(day);
  return inTx(db, async (c) => {
    await ensureMonth(c, month);
    if (operatorId == null) {
      await c.query("DELETE FROM roster_entries WHERE product_id = $1 AND date = $2", [productId, day]);
      return null;
    }
    const ok = await rosterEligibility(c, operatorId, productId);
    if (!ok.ok) throw new CatalogueError(422, ok.reason);
    const r = await c.query(
      `INSERT INTO roster_entries (month, product_id, date, operator_id, source, updated_by)
       VALUES ($1, $2, $3, $4, 'override', $5)
       ON CONFLICT (product_id, date) DO UPDATE SET operator_id = EXCLUDED.operator_id, source = 'override',
              updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`, [month, productId, day, operatorId, by]);
    return mapEntry(r.rows[0]);
  });
}

// Publishing makes the month visible to operators and assignable. Every entry
// is checked once more: an operator suspended since the plan was built is
// reported, not published silently.
export async function publishMonth(db, month, { by, now = Date.now() } = {}) {
  checkMonth(month);
  return inTx(db, async (c) => {
    await ensureMonth(c, month);
    const entries = (await c.query("SELECT * FROM roster_entries WHERE month = $1", [month])).rows;
    const problems = [];
    for (const e of entries) {
      const ok = await rosterEligibility(c, Number(e.operator_id), Number(e.product_id));
      if (!ok.ok) problems.push({ date: ymd(e.date), productId: Number(e.product_id), reason: ok.reason });
    }
    if (problems.length) {
      const first = problems[0];
      throw Object.assign(new CatalogueError(422, `${problems.length} entr${problems.length === 1 ? "y" : "ies"} can't be published: ${first.date}, ${first.reason}`), { problems });
    }
    await c.query(
      `UPDATE roster_months SET state = 'published', published_at = now(), published_by = $2 WHERE month = $1`, [month, by]);
    const deadline = rosterDeadline(month);
    return { month, entries: entries.length, late: todayIn(now) > deadline, deadline };
  });
}

// Who is rostered for a product on a date: only from a PUBLISHED month.
export async function rosteredOperator(db, productId, date) {
  const r = await db.query(
    `SELECT e.operator_id, o.status FROM roster_entries e
       JOIN roster_months m ON m.month = e.month AND m.state = 'published'
       JOIN operators o ON o.id = e.operator_id
      WHERE e.product_id = $1 AND e.date = $2`, [productId, ymd(date)]);
  return r.rows[0] ? { operatorId: Number(r.rows[0].operator_id), status: r.rows[0].status } : null;
}

// An operator's own published roster.
export async function operatorRoster(db, operatorId, { from, to } = {}) {
  const r = await db.query(
    `SELECT e.*, c.title, c.code FROM roster_entries e
       JOIN roster_months m ON m.month = e.month AND m.state = 'published'
       JOIN catalogue_products c ON c.id = e.product_id
      WHERE e.operator_id = $1 AND ($2::date IS NULL OR e.date >= $2) AND ($3::date IS NULL OR e.date <= $3)
      ORDER BY e.date`, [operatorId, from || null, to || null]);
  return r.rows.map((x) => ({ id: Number(x.id), date: ymd(x.date), productId: Number(x.product_id), title: x.title, code: x.code, source: x.source }));
}

// ---------------------------------------------------------------- swaps
export async function requestSwap(db, { entryId, fromOperatorId, toOperatorId, note = null, by }) {
  return inTx(db, async (c) => {
    const e = (await c.query(
      `SELECT e.* FROM roster_entries e JOIN roster_months m ON m.month = e.month AND m.state = 'published'
        WHERE e.id = $1 FOR UPDATE OF e`, [entryId])).rows[0];
    if (!e) throw new CatalogueError(404, "Roster entry not found.");
    if (Number(e.operator_id) !== Number(fromOperatorId)) throw new CatalogueError(403, "That date isn't on your roster.");
    if (Number(toOperatorId) === Number(fromOperatorId)) throw new CatalogueError(422, "Pick another operator.");
    const ok = await rosterEligibility(c, toOperatorId, Number(e.product_id));
    if (!ok.ok) throw new CatalogueError(422, ok.reason);
    try {
      const r = await c.query(
        `INSERT INTO roster_swaps (entry_id, from_operator_id, to_operator_id, note, requested_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`, [entryId, fromOperatorId, toOperatorId, note, by]);
      return { id: Number(r.rows[0].id), state: "requested" };
    } catch (err) {
      if (err?.code === "23505") throw new CatalogueError(409, "A swap is already waiting for approval on this date.");
      throw err;
    }
  });
}

// An admin decides. Approving moves the date to the other operator, provided
// it is still eligible, and records who approved.
export async function decideSwap(db, { swapId, approve, by }) {
  return inTx(db, async (c) => {
    const s = (await c.query("SELECT * FROM roster_swaps WHERE id = $1 FOR UPDATE", [swapId])).rows[0];
    if (!s) throw new CatalogueError(404, "Swap not found.");
    if (s.state !== "requested") throw new CatalogueError(409, `This swap is already ${s.state}.`);
    if (approve) {
      const e = (await c.query("SELECT * FROM roster_entries WHERE id = $1 FOR UPDATE", [s.entry_id])).rows[0];
      if (!e || Number(e.operator_id) !== Number(s.from_operator_id)) throw new CatalogueError(409, "The roster changed since this swap was requested.");
      const ok = await rosterEligibility(c, Number(s.to_operator_id), Number(e.product_id));
      if (!ok.ok) throw new CatalogueError(422, ok.reason);
      await c.query(
        "UPDATE roster_entries SET operator_id = $2, source = 'swap', updated_by = $3, updated_at = now() WHERE id = $1",
        [s.entry_id, s.to_operator_id, by]);
    }
    const r = await c.query(
      `UPDATE roster_swaps SET state = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`,
      [swapId, approve ? "approved" : "rejected", by]);
    return { id: Number(r.rows[0].id), state: r.rows[0].state, decidedBy: r.rows[0].decided_by };
  });
}

// Open departures with no operator on a published roster, for the admin
// calendar's flag.
export async function unrosteredDepartures(db, { from, to }) {
  const r = await db.query(
    `SELECT cd.id FROM catalogue_departures cd
      WHERE cd.status IN ('open', 'go_ahead') AND cd.date BETWEEN $1 AND $2
        AND NOT EXISTS (SELECT 1 FROM roster_entries e JOIN roster_months m ON m.month = e.month AND m.state = 'published'
                         JOIN operators o ON o.id = e.operator_id AND o.status = 'active'
                         WHERE e.product_id = cd.product_id AND e.date = cd.date)`, [from, to]);
  return new Set(r.rows.map((x) => Number(x.id)));
}
