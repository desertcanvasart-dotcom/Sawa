// The Sawa catalogue and its departure calendar: data access, the generator,
// the status job and the admin actions (model phase 1).
//
// The rules themselves live in shared/catalogue.js; this module reads and
// writes rows and supplies the clock. Money is not touched anywhere here:
// nothing is charged, refunded or paid out.
//
// Bookings stay in the existing tables. A catalogue departure is sold through
// an ordinary `departures` row (legacy_departure_id), created here only when
// the catalogue_v2 flag is on, and its seats are counted from `pledges`.
import { pool, withTransaction } from "./db/index.js";
import { TOUR_TIMEZONE, zonedDateTimeToUtc } from "./tz.js";
import { cancelDepartureAndPledges } from "./departure-cancel.js";
import {
  PRODUCT_TYPES, PRODUCT_STATUSES, shiftDate, plannedDates, nextStatus, canRunBelowMinimum,
  activeSpec, publishBlockers, specGaps, usesDeadline, legacyTypeFor,
} from "../shared/catalogue.js";

export class CatalogueError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 42P01 undefined_table, 42703 undefined_column: migration 047 not applied yet.
export const isMissingCatalogueTables = (e) => e?.code === "42P01" || e?.code === "42703";

export function todayIn(now = Date.now(), timeZone = TOUR_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(now));
}

// On the shared pool, a transaction of its own. Given a client (a test, or a
// caller already inside a transaction), run on that client as it is.
const inTransaction = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------- mapping
export function mapCatalogueProduct(r) {
  return {
    id: Number(r.id),
    catalogueNo: r.catalogue_no,
    code: r.code,
    slug: r.slug,
    title: r.title,
    type: r.type,
    baseCity: r.base_city,
    endCity: r.end_city,
    status: r.status,
    mergedIntoId: r.merged_into_id == null ? null : Number(r.merged_into_id),
    goaheadMin: r.goahead_min,
    maxGroup: r.max_group,
    cutoffHours: r.cutoff_hours,
    goaheadDeadlineDays: r.goahead_deadline_days,
    legacyProductId: r.legacy_product_id,
    updatedAt: r.updated_at,
  };
}

export function mapSpec(r) {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    version: r.version,
    state: r.state,
    effectiveFrom: ymd(r.effective_from),
    content: r.content || {},
    sources: r.sources || {},
    createdBy: r.created_by,
    createdAt: r.created_at,
    publishedBy: r.published_by,
    publishedAt: r.published_at,
  };
}

export function mapRule(r) {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    kind: r.kind,
    weekdays: r.weekdays ? r.weekdays.map(Number) : null,
    intervalWeeks: r.interval_weeks,
    anchorDate: ymd(r.anchor_date),
    dates: r.dates ? r.dates.map(ymd) : null,
    activeFrom: ymd(r.active_from),
    activeTo: ymd(r.active_to),
    note: r.note,
  };
}

export function mapCatalogueDeparture(r) {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    date: ymd(r.date),
    specVersionId: r.spec_version_id == null ? null : Number(r.spec_version_id),
    status: r.status,
    origin: r.origin,
    legacyDepartureId: r.legacy_departure_id,
    seatsSold: Number(r.seats_sold || 0),
    runBelowMinimum: r.run_below_minimum,
    overrideBy: r.override_by,
    overrideReason: r.override_reason,
    overrideAt: r.override_at,
    statusChangedAt: r.status_changed_at,
  };
}

// ---------------------------------------------------------------- instants
// When a departure starts, when its sales close, when a cruise or multi-day
// must have reached GoAhead, and when it ends — all in the tour timezone.
//
// The start time comes from the spec it is sold under, then from the listing
// it is sold through, then 08:00. The end of a multi-day departure is its last
// night's following day.
export function departureInstants(dep, product, { startTime, nights } = {}) {
  const startsAt = zonedDateTimeToUtc(dep.date, startTime || "08:00");
  const cutoffAt = startsAt - Number(product.cutoffHours ?? 48) * HOUR_MS;
  const deadlineAt = usesDeadline(product.type) && product.goaheadDeadlineDays != null
    ? startsAt - Number(product.goaheadDeadlineDays) * DAY_MS
    : NaN;
  const lastDay = shiftDate(dep.date, Math.max(0, Number(nights) || 0));
  const endsAt = zonedDateTimeToUtc(lastDay, "23:59");
  return { startsAt, cutoffAt, deadlineAt, endsAt };
}

// ---------------------------------------------------------------- reads
export async function listProducts(db = pool) {
  const r = await db.query("SELECT * FROM catalogue_products ORDER BY catalogue_no");
  return r.rows.map(mapCatalogueProduct);
}

export async function getProduct(db, id) {
  const r = await db.query("SELECT * FROM catalogue_products WHERE id = $1", [id]);
  if (!r.rows.length) throw new CatalogueError(404, "Catalogue product not found.");
  return mapCatalogueProduct(r.rows[0]);
}

export async function specsFor(db, productId) {
  const r = await db.query("SELECT * FROM catalogue_spec_versions WHERE product_id = $1 ORDER BY version", [productId]);
  return r.rows.map(mapSpec);
}

export async function rulesFor(db, productId) {
  const r = await db.query("SELECT * FROM catalogue_calendar_rules WHERE product_id = $1 ORDER BY id", [productId]);
  return r.rows.map(mapRule);
}

// Departures with their derived seat counts.
export async function listDepartures(db = pool, { from, to, productId } = {}) {
  const where = [];
  const args = [];
  if (from) { args.push(from); where.push(`cd.date >= $${args.length}`); }
  if (to) { args.push(to); where.push(`cd.date <= $${args.length}`); }
  if (productId) { args.push(productId); where.push(`cd.product_id = $${args.length}`); }
  const r = await db.query(
    `SELECT cd.*, s.seats_sold
       FROM catalogue_departures cd
       JOIN catalogue_departure_seats s ON s.catalogue_departure_id = cd.id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY cd.date, cd.product_id`,
    args
  );
  return r.rows.map(mapCatalogueDeparture);
}

// Everything the jobs need about each product in one pass: the product, its
// rules, its spec versions and the listing it is sold through.
async function loadWorld(db) {
  const [products, rules, specs, legacy] = await Promise.all([
    db.query("SELECT * FROM catalogue_products ORDER BY catalogue_no"),
    db.query("SELECT * FROM catalogue_calendar_rules"),
    db.query("SELECT * FROM catalogue_spec_versions"),
    db.query(`SELECT t.* FROM tour_products t
               WHERE t.id IN (SELECT legacy_product_id FROM catalogue_products WHERE legacy_product_id IS NOT NULL)`),
  ]);
  const byProduct = (rows, map) => {
    const m = new Map();
    for (const row of rows) {
      const k = Number(row.product_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(map(row));
    }
    return m;
  };
  return {
    products: products.rows.map(mapCatalogueProduct),
    rules: byProduct(rules.rows, mapRule),
    specs: byProduct(specs.rows, mapSpec),
    legacy: new Map(legacy.rows.map((t) => [t.id, t])),
  };
}

function timingFor(world, product, specVersionId) {
  const versions = world.specs.get(product.id) || [];
  const spec = versions.find((v) => v.id === specVersionId) || null;
  const listing = product.legacyProductId ? world.legacy.get(product.legacyProductId) : null;
  return {
    startTime: spec?.content?.startTime || listing?.default_time || "08:00",
    nights: listing?.nights || 0,
  };
}

// ---------------------------------------------------------------- generator
//
// Creates departures from the calendar rules for each active product, over a
// rolling window (90 days for day and one-way tours, 365 for cruises and
// multi-day). Idempotent: UNIQUE (product, date) plus ON CONFLICT DO NOTHING
// means a second run creates nothing, and a concurrent run can't double up.
//
// Before generating, existing future departures of the linked listing are
// ADOPTED: linked as they are, bookings untouched, so a date that already has
// travellers is never duplicated. Adopted departures keep the old rules.
//
// `materialise` (the catalogue_v2 flag) additionally creates the ordinary
// departures row each generated departure is sold through. With the flag off
// nothing outside the catalogue tables is written, so the public site cannot
// change.
export async function generateDepartures({ db = pool, now = Date.now(), materialise = false, log = () => {} } = {}) {
  const today = todayIn(now);
  const world = await loadWorld(db);
  const out = { created: 0, adopted: 0, materialised: 0 };

  for (const product of world.products) {
    const versions = world.specs.get(product.id) || [];
    const spec = activeSpec(versions, today);

    // Adopt first, for any status: a held product's existing bookings still
    // need to be visible in the calendar view.
    if (product.legacyProductId) {
      // A date the generator already made but hasn't made bookable, that has
      // since got an ordinary departure (an admin booking, say): link that one
      // rather than making a second departure on the same day.
      const linked = await db.query(
        `UPDATE catalogue_departures cd SET legacy_departure_id = d.id, origin = 'adopted',
                status = CASE WHEN d.status IN ('minimum_reached', 'supplier_confirmed') THEN 'go_ahead' ELSE cd.status END
           FROM (SELECT DISTINCT ON (d.date) d.id, d.date, d.status FROM departures d
                  WHERE d.tour_product_id = $2
                    AND d.status NOT IN ('cancelled', 'pending_review', 'closed')
                    AND d.date >= $3
                    AND NOT EXISTS (SELECT 1 FROM catalogue_departures x WHERE x.legacy_departure_id = d.id)
                  ORDER BY d.date,
                           (SELECT COALESCE(SUM(p.seats), 0) FROM pledges p WHERE p.departure_id = d.id AND p.status <> 'cancelled') DESC,
                           d.id) d
          WHERE cd.product_id = $1 AND cd.date = d.date AND cd.legacy_departure_id IS NULL AND cd.status = 'open'`,
        [product.id, product.legacyProductId, today]
      );
      out.adopted += linked.rowCount;
      const adopted = await db.query(
        `INSERT INTO catalogue_departures (product_id, date, spec_version_id, status, origin, legacy_departure_id)
         SELECT DISTINCT ON (d.date) $1, d.date, $2,
                CASE WHEN d.status IN ('minimum_reached', 'supplier_confirmed') THEN 'go_ahead' ELSE 'open' END,
                'adopted', d.id
           FROM departures d
          WHERE d.tour_product_id = $3
            AND d.status NOT IN ('cancelled', 'pending_review', 'closed')
            AND d.date >= $4
            AND NOT EXISTS (SELECT 1 FROM catalogue_departures x WHERE x.legacy_departure_id = d.id)
          ORDER BY d.date,
                   (SELECT COALESCE(SUM(p.seats), 0) FROM pledges p WHERE p.departure_id = d.id AND p.status <> 'cancelled') DESC,
                   d.id
         ON CONFLICT (product_id, date) DO NOTHING`,
        [product.id, spec?.id ?? null, product.legacyProductId, today]
      );
      out.adopted += adopted.rowCount;
    }

    // A date whose decision point (cut-off, or GoAhead deadline) has already
    // passed could only ever be created to be cancelled.
    const timing = timingFor(world, product, spec?.id ?? null);
    const dates = plannedDates(product, world.rules.get(product.id) || [], today).filter((date) => {
      const at = departureInstants({ date }, product, timing);
      return now < (usesDeadline(product.type) ? at.deadlineAt : at.cutoffAt);
    });
    if (dates.length) {
      const created = await db.query(
        `INSERT INTO catalogue_departures (product_id, date, spec_version_id, origin)
         SELECT $1, d::date, $2, 'generated' FROM unnest($3::date[]) AS d
         ON CONFLICT (product_id, date) DO NOTHING`,
        [product.id, spec?.id ?? null, dates]
      );
      out.created += created.rowCount;
    }
  }

  if (materialise) out.materialised = await materialiseBookable({ db, today, world, log });
  if (out.created || out.adopted || out.materialised) {
    log(`catalogue: ${out.created} departure(s) created, ${out.adopted} adopted, ${out.materialised} made bookable`);
  }
  return out;
}

// The ordinary departures row a generated catalogue departure is sold through.
// Built the same way POST /api/admin/departures builds one, from the listing,
// minus the first booking and the listing description in `notes`.
async function materialiseBookable({ db, today, world, log }) {
  const pending = await db.query(
    `SELECT cd.* FROM catalogue_departures cd
       JOIN catalogue_products c ON c.id = cd.product_id
      WHERE cd.origin = 'generated' AND cd.legacy_departure_id IS NULL
        AND cd.status IN ('open', 'go_ahead') AND cd.date >= $1
        AND c.status = 'active' AND c.legacy_product_id IS NOT NULL
        -- Only for products a traveller can see: a published specification in
        -- effect. Until then there is nothing to sell a seat on.
        AND EXISTS (SELECT 1 FROM catalogue_spec_versions s
                     WHERE s.product_id = c.id AND s.state = 'published' AND s.effective_from <= $1)`,
    [today]
  );
  let made = 0;
  for (const row of pending.rows) {
    const product = world.products.find((p) => p.id === Number(row.product_id));
    const t = product && world.legacy.get(product.legacyProductId);
    if (!t) continue;
    try {
      made += await inTransaction(db, async (client) => {
      // Re-read under lock: two overlapping runs must not make two rows.
      const again = await client.query(
        "SELECT legacy_departure_id FROM catalogue_departures WHERE id = $1 FOR UPDATE", [row.id]);
      if (again.rows[0]?.legacy_departure_id == null) {
        const date = ymd(row.date);
        const isPkg = t.type === "package";
        const endDate = isPkg && t.nights ? shiftDate(date, Number(t.nights)) : null;
        const id = (await client.query("SELECT nextval('departures_id_seq') AS id")).rows[0].id;
        await client.query(
          `INSERT INTO departures
            (id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time,
             city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price,
             quality, status, notes, deposit_percent)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'open',NULL,$20)`,
          [id, t.type, t.id, t.title, date, isPkg ? date : null, endDate, isPkg ? t.nights : null,
            isPkg ? JSON.stringify(t.cities || []) : null, t.default_time,
            t.city, t.guide, t.vehicle, product.goaheadMin, product.maxGroup,
            t.base_cost ?? 0, t.published_rate, t.break_price ?? Math.round(t.published_rate * 0.8),
            t.quality, t.deposit_percent]
        );
        await client.query("UPDATE catalogue_departures SET legacy_departure_id = $1 WHERE id = $2", [id, row.id]);
        return 1;
      }
      return 0;
      });
    } catch (e) {
      // One bad row must not stop the rest; it is retried on the next run.
      log(`catalogue: could not make departure ${row.id} bookable — ${e.message}`);
    }
  }
  return made;
}

// ---------------------------------------------------------------- status job
//
// Moves departures between statuses (nextStatus in shared/catalogue.js). This
// phase only sets statuses: the traveller message and the next-date offer are
// written as catalogue_events for a later phase to send.
//
// A generated departure cancelled below its minimum also cancels the ordinary
// departure it was sold through, with its bookings, exactly as the existing
// unconfirmed-date job does, so the booking lookup tells the traveller the
// truth. Nothing is charged or refunded: no money has been taken before the
// GoAhead.
export async function runStatusJob({ db = pool, now = Date.now(), log = () => {} } = {}) {
  const today = todayIn(now);
  const world = await loadWorld(db);
  const products = new Map(world.products.map((p) => [p.id, p]));
  const rows = await db.query(
    `SELECT cd.*, s.seats_sold
       FROM catalogue_departures cd
       JOIN catalogue_departure_seats s ON s.catalogue_departure_id = cd.id
      WHERE cd.status IN ('open', 'go_ahead')`
  );
  const out = { go_ahead: 0, cancelled_below_minimum: 0, completed: 0, stamped: 0 };

  for (const row of rows.rows) {
    const dep = mapCatalogueDeparture(row);
    const product = products.get(dep.productId);
    if (!product) continue;

    // A departure with seats sold keeps the spec it was sold under. If it had
    // none yet (nothing was published when it was generated), it takes the one
    // active now, and keeps that one.
    if (dep.seatsSold > 0 && dep.specVersionId == null) {
      const spec = activeSpec(world.specs.get(product.id) || [], today);
      if (spec) {
        await db.query("UPDATE catalogue_departures SET spec_version_id = $1 WHERE id = $2 AND spec_version_id IS NULL", [spec.id, dep.id]);
        dep.specVersionId = spec.id;
        out.stamped += 1;
      }
    }

    const instants = departureInstants(dep, product, timingFor(world, product, dep.specVersionId));
    const next = nextStatus({ ...dep, ...instants, goaheadMin: product.goaheadMin, type: product.type }, now);
    if (next.status === dep.status) continue;

    const changed = await transition(db, dep, next, product);
    if (changed) {
      out[next.status] += 1;
      log(`catalogue: departure ${dep.id} (${product.code} ${dep.date}) ${dep.status} → ${next.status} (${next.reason})`);
    }
  }
  return out;
}

function transition(db, dep, next, product) {
  return inTransaction(db, async (client) => {
    // Only from the status we read: a concurrent run or an admin override that
    // got there first wins, and this one does nothing.
    const upd = await client.query(
      `UPDATE catalogue_departures SET status = $1, status_changed_at = now()
        WHERE id = $2 AND status = $3`,
      [next.status, dep.id, dep.status]
    );
    if (!upd.rowCount) return false;
    const payload = { productId: product.id, code: product.code, date: dep.date, reason: next.reason, seatsSold: dep.seatsSold };

    if (next.status === "cancelled_below_minimum") {
      let released = 0;
      if (dep.legacyDepartureId && dep.origin === "generated") {
        released = (await cancelDepartureAndPledges(client, dep.legacyDepartureId)).pledgesCancelled;
      }
      const nextDate = await client.query(
        `SELECT cd.date FROM catalogue_departures cd
          WHERE cd.product_id = $1 AND cd.date > $2 AND cd.status IN ('open', 'go_ahead')
          ORDER BY cd.date LIMIT 1`,
        [product.id, dep.date]
      );
      // Only a departure somebody booked has anybody to tell.
      if (dep.seatsSold > 0 || released > 0) {
        await addEvent(client, dep.id, "traveller_notice.cancelled_below_minimum", { ...payload, bookingsReleased: released });
        await addEvent(client, dep.id, "next_date_offer", { ...payload, nextDate: ymd(nextDate.rows[0]?.date) || null });
      }
    } else if (next.status === "go_ahead") {
      // For the roster phase: this is the moment a departure is assigned.
      await addEvent(client, dep.id, "go_ahead", payload);
    } else if (next.status === "completed") {
      await addEvent(client, dep.id, "completed", payload);
    }
    return true;
  });
}

function addEvent(db, departureId, type, payload) {
  return db.query(
    `INSERT INTO catalogue_events (departure_id, type, payload) VALUES ($1, $2, $3)
     ON CONFLICT (departure_id, type) DO NOTHING`,
    [departureId, type, JSON.stringify(payload)]
  );
}

// ---------------------------------------------------------------- override
//
// "Run below minimum": an admin decides a departure runs although it is below
// its GoAhead minimum (the operator is then paid at the 4–6 band, in a later
// phase). Records who and why; both are required.
//
// Allowed while the departure is open, or after it was cancelled below the
// minimum only if nothing had been booked on it: re-instating released
// bookings is not something this phase does behind a traveller's back.
export async function runBelowMinimum({ db = pool, departureId, by, reason, now = Date.now() }) {
  const why = String(reason || "").trim();
  if (!by) throw new CatalogueError(403, "Signed-in staff only.");
  if (why.length < 5) throw new CatalogueError(422, "Say why this departure should run below its minimum.");

  return inTransaction(db, async (client) => {
    const r = await client.query(
      `SELECT cd.*, s.seats_sold FROM catalogue_departures cd
         JOIN catalogue_departure_seats s ON s.catalogue_departure_id = cd.id
        WHERE cd.id = $1 FOR UPDATE OF cd`,
      [departureId]
    );
    if (!r.rows.length) throw new CatalogueError(404, "Departure not found.");
    const dep = mapCatalogueDeparture(r.rows[0]);
    const product = mapCatalogueProduct((await client.query("SELECT * FROM catalogue_products WHERE id = $1", [dep.productId])).rows[0]);
    const listing = product.legacyProductId
      ? (await client.query("SELECT default_time FROM tour_products WHERE id = $1", [product.legacyProductId])).rows[0]
      : null;
    const { startsAt } = departureInstants(dep, product, { startTime: listing?.default_time });
    if (!canRunBelowMinimum({ ...dep, startsAt }, now)) {
      throw new CatalogueError(409, dep.status === "go_ahead" ? "This departure is already going ahead."
        : "This departure has already started or ended.");
    }
    if (dep.status === "cancelled_below_minimum" && dep.legacyDepartureId) {
      const booked = await client.query("SELECT 1 FROM pledges WHERE departure_id = $1 LIMIT 1", [dep.legacyDepartureId]);
      if (booked.rows.length) {
        throw new CatalogueError(409, "Bookings on this date were already released when it was cancelled. Use the override before the cut-off.");
      }
    }

    await client.query(
      `UPDATE catalogue_departures
          SET run_below_minimum = true, override_by = $2, override_reason = $3, override_at = now(),
              status = 'go_ahead', status_changed_at = now()
        WHERE id = $1`,
      [dep.id, by, why]
    );
    // The date it is sold through reads as confirmed too, so the booking engine
    // and the old jobs treat it as running. The status is set directly, not via
    // refreshStatus, so no old GoAhead emails are queued.
    if (dep.legacyDepartureId) {
      await client.query(
        `UPDATE departures SET status = 'minimum_reached' WHERE id = $1 AND status IN ('open', 'cancelled')`,
        [dep.legacyDepartureId]
      );
    }
    await addEvent(client, dep.id, "go_ahead", {
      productId: product.id, code: product.code, date: dep.date, reason: "admin_override", seatsSold: dep.seatsSold,
    });
    return { ...dep, status: "go_ahead", runBelowMinimum: true, overrideBy: by, overrideReason: why };
  });
}

// ---------------------------------------------------------------- admin writes
const PRODUCT_FIELDS = {
  title: "title", type: "type", baseCity: "base_city", endCity: "end_city", status: "status",
  mergedIntoId: "merged_into_id", goaheadMin: "goahead_min", maxGroup: "max_group",
  cutoffHours: "cutoff_hours", goaheadDeadlineDays: "goahead_deadline_days", legacyProductId: "legacy_product_id",
};

export async function updateProduct(db, id, patch) {
  const sets = [];
  const args = [id];
  for (const [key, col] of Object.entries(PRODUCT_FIELDS)) {
    if (!(key in patch)) continue;
    let v = patch[key];
    if (key === "type" && !PRODUCT_TYPES.includes(v)) throw new CatalogueError(422, "Unknown product type.");
    if (key === "status" && !PRODUCT_STATUSES.includes(v)) throw new CatalogueError(422, "Unknown status.");
    if (typeof v === "string") v = v.trim() || null;
    if (key === "title" && !v) throw new CatalogueError(422, "A product needs a title.");
    args.push(v === undefined ? null : v);
    sets.push(`${col} = $${args.length}`);
  }
  if (!sets.length) return getProduct(db, id);
  try {
    const r = await db.query(
      `UPDATE catalogue_products SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, args);
    if (!r.rows.length) throw new CatalogueError(404, "Catalogue product not found.");
    return mapCatalogueProduct(r.rows[0]);
  } catch (e) {
    throw constraintError(e);
  }
}

// Database constraints are the authority; this turns their names into
// sentences an admin can act on.
function constraintError(e) {
  const map = {
    catalogue_products_deadline_chk: "Cruises and multi-day tours need a GoAhead deadline; other types must not have one.",
    catalogue_products_end_city_chk: "A one-way road tour needs an end city.",
    catalogue_products_group_chk: "The maximum group must be between the GoAhead minimum and 12.",
    catalogue_products_merge_chk: "Only a retired product can be merged into another one.",
    catalogue_products_legacy_product_id_key: "That listing is already linked to another catalogue product.",
    catalogue_products_legacy_product_id_fkey: "No listing has that id.",
    catalogue_rules_shape_chk: "A weekday rule needs at least one weekday (and a start date when it repeats every few weeks); a dates rule needs dates.",
    catalogue_rules_window_chk: "The rule ends before it starts.",
  };
  if (e?.constraint && map[e.constraint]) return new CatalogueError(422, map[e.constraint]);
  if (e?.code === "23514" || e?.code === "23505" || e?.code === "22P02" || e?.code === "22007" || e?.code === "22008") {
    return new CatalogueError(422, "Those values aren't valid for this product.");
  }
  return e;
}

// A new draft, copied from the latest version. At most one draft per product.
export async function createDraft(db, productId, by) {
  await getProduct(db, productId);
  const versions = await specsFor(db, productId);
  if (versions.some((v) => v.state === "draft")) throw new CatalogueError(409, "This product already has a draft. Edit or publish it first.");
  const latest = versions[versions.length - 1];
  const r = await db.query(
    `INSERT INTO catalogue_spec_versions (product_id, version, state, content, sources, created_by)
     VALUES ($1, $2, 'draft', $3, $4, $5) RETURNING *`,
    [productId, (latest?.version || 0) + 1, JSON.stringify(latest?.content || {}),
      JSON.stringify(latest ? { copiedFrom: `version ${latest.version}` } : {}), by]
  );
  return mapSpec(r.rows[0]);
}

export async function saveDraft(db, productId, versionId, content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new CatalogueError(422, "The specification must be an object.");
  const r = await db.query(
    `UPDATE catalogue_spec_versions SET content = $3
      WHERE id = $1 AND product_id = $2 AND state = 'draft' RETURNING *`,
    [versionId, productId, JSON.stringify(content)]
  );
  if (!r.rows.length) throw new CatalogueError(409, "Only a draft can be edited. Create a new version to change a published one.");
  return mapSpec(r.rows[0]);
}

// Publishing fixes the version for good. Departures from its effective date
// that have no seats sold move onto it; any with seats sold keep the version
// they were sold under.
export async function publishDraft({ db = pool, productId, versionId, effectiveFrom, by, now = Date.now() }) {
  const today = todayIn(now);
  const from = ymd(effectiveFrom) || today;
  if (from < today) throw new CatalogueError(422, "A specification can't take effect in the past.");

  return inTransaction(db, async (client) => {
    const r = await client.query(
      "SELECT * FROM catalogue_spec_versions WHERE id = $1 AND product_id = $2 FOR UPDATE", [versionId, productId]);
    if (!r.rows.length) throw new CatalogueError(404, "Specification version not found.");
    const spec = mapSpec(r.rows[0]);
    if (spec.state !== "draft") throw new CatalogueError(409, "That version is already published.");
    const blockers = publishBlockers(spec.content);
    if (blockers.length) throw new CatalogueError(422, `Add ${blockers.join(" and ")} before publishing: the public page prints them from the specification.`);

    const pub = await client.query(
      `UPDATE catalogue_spec_versions SET state = 'published', effective_from = $2, published_by = $3, published_at = now()
        WHERE id = $1 RETURNING *`,
      [versionId, from, by]
    );
    const moved = await client.query(
      `UPDATE catalogue_departures cd SET spec_version_id = $1
        WHERE cd.product_id = $2 AND cd.date >= $3 AND cd.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM pledges p WHERE p.departure_id = cd.legacy_departure_id AND p.status <> 'cancelled')
          AND (cd.spec_version_id IS NULL
               OR (SELECT s.effective_from FROM catalogue_spec_versions s WHERE s.id = cd.spec_version_id) <= $3)`,
      [versionId, productId, from]
    );
    return { spec: mapSpec(pub.rows[0]), departuresMoved: moved.rowCount };
  });
}

export async function addRule(db, productId, rule) {
  await getProduct(db, productId);
  const kind = rule.kind === "dates" ? "dates" : "weekdays";
  try {
    const r = await db.query(
      `INSERT INTO catalogue_calendar_rules (product_id, kind, weekdays, interval_weeks, anchor_date, dates, active_from, active_to, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [productId, kind,
        kind === "weekdays" ? (rule.weekdays || []).map(Number) : null,
        kind === "weekdays" ? Math.max(1, Number(rule.intervalWeeks) || 1) : 1,
        kind === "weekdays" ? ymd(rule.anchorDate) : null,
        kind === "dates" ? (rule.dates || []).map(ymd).filter(Boolean) : null,
        ymd(rule.activeFrom), ymd(rule.activeTo), rule.note ? String(rule.note).slice(0, 200) : null]
    );
    return mapRule(r.rows[0]);
  } catch (e) {
    if (e?.code === "23502") throw new CatalogueError(422, "A rule needs a start date.");
    throw constraintError(e);
  }
}

// Removing a rule stops future generation from it. Departures it already made
// stay: some may have bookings, and cancelling them is a status decision, not a
// side effect of editing the calendar.
export async function deleteRule(db, productId, ruleId) {
  const r = await db.query("DELETE FROM catalogue_calendar_rules WHERE id = $1 AND product_id = $2", [ruleId, productId]);
  if (!r.rowCount) throw new CatalogueError(404, "Rule not found.");
}

// What the product editor shows for one product.
export async function productDetail(db, id, now = Date.now()) {
  const product = await getProduct(db, id);
  const [specs, rules] = await Promise.all([specsFor(db, id), rulesFor(db, id)]);
  const active = activeSpec(specs, todayIn(now));
  return {
    product,
    specs: specs.map((s) => ({ ...s, gaps: specGaps(s.content, product.type) })),
    activeSpecId: active?.id ?? null,
    rules,
    legacyType: legacyTypeFor(product.type),
  };
}
