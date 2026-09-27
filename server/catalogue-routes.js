// Admin API for the catalogue and departure calendar (model phase 1).
//
// Platform staff only (super_admin, ops_staff), behind the same auth as every
// other /api/admin route. Until migration 047 is applied every route answers
// 503 "not switched on yet", like the payments screens.
import { z } from "zod";
import { pool } from "./db/index.js";
import {
  CatalogueError, isMissingCatalogueTables, listProducts, productDetail, updateProduct,
  createDraft, saveDraft, publishDraft, addRule, deleteRule, listDepartures, runBelowMinimum,
  generateDepartures, runStatusJob, departureInstants, todayIn, mapSpec,
} from "./catalogue.js";
import { catalogueV2Enabled } from "./features.js";
import {
  PRODUCT_TYPES, PRODUCT_STATUSES, activeSpec, specGaps, publicDateLabel, shiftDate,
} from "../shared/catalogue.js";

const notSwitchedOn = () => Object.assign(
  new CatalogueError(503, "The catalog isn't switched on yet: migration 047 has not been applied to this database."),
  { expose: true });

const productPatch = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  type: z.enum(PRODUCT_TYPES).optional(),
  baseCity: z.string().trim().min(1).max(60).optional(),
  endCity: z.string().trim().max(60).nullable().optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  mergedIntoId: z.number().int().positive().nullable().optional(),
  goaheadMin: z.number().int().min(1).max(12).optional(),
  maxGroup: z.number().int().min(1).max(12).optional(),
  cutoffHours: z.number().int().min(0).max(2160).optional(),
  goaheadDeadlineDays: z.number().int().min(1).max(365).nullable().optional(),
  legacyProductId: z.string().trim().max(120).nullable().optional(),
  needsNationality: z.boolean().optional(),
}).strict();

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-13.");
const ruleSchema = z.object({
  kind: z.enum(["weekdays", "dates"]),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  intervalWeeks: z.number().int().min(1).max(8).optional(),
  anchorDate: ymdSchema.nullable().optional(),
  dates: z.array(ymdSchema).max(400).optional(),
  activeFrom: ymdSchema,
  activeTo: ymdSchema.nullable().optional(),
  note: z.string().max(200).nullable().optional(),
});

export function registerCatalogueRoutes(app, { requireAuth, requireRole, h, logAudit, invalidatePublic = () => {} }) {
  const staff = [requireAuth, requireRole("super_admin", "ops_staff")];
  // Every handler runs through this: a missing table becomes the 503 above.
  const route = (fn) => h(async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (isMissingCatalogueTables(e)) throw notSwitchedOn();
      throw e;
    }
  });
  const by = (req) => req.user?.email || req.user?.id || null;
  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new CatalogueError(404, "Not found.");
    return n;
  };

  // The catalogue list: every product with what an admin needs at a glance.
  app.get("/api/admin/catalogue", ...staff, route(async (_req, res) => {
    const today = todayIn();
    const [products, specs, rules, upcoming, listings] = await Promise.all([
      listProducts(),
      pool.query("SELECT * FROM catalogue_spec_versions"),
      pool.query("SELECT product_id, COUNT(*)::int AS n FROM catalogue_calendar_rules GROUP BY product_id"),
      pool.query(`SELECT product_id, COUNT(*) FILTER (WHERE status IN ('open','go_ahead'))::int AS live,
                         COUNT(*) FILTER (WHERE status = 'go_ahead')::int AS going
                    FROM catalogue_departures WHERE date >= $1 GROUP BY product_id`, [today]),
      pool.query("SELECT id, title, type, status, active FROM tour_products ORDER BY title"),
    ]);
    const specsBy = new Map();
    for (const s of specs.rows.map(mapSpec)) {
      if (!specsBy.has(s.productId)) specsBy.set(s.productId, []);
      specsBy.get(s.productId).push(s);
    }
    const count = (rows, key) => new Map(rows.map((r) => [Number(r.product_id), r[key]]));
    const ruleCount = count(rules.rows, "n");
    const live = count(upcoming.rows, "live");
    const going = count(upcoming.rows, "going");
    res.json({
      flag: catalogueV2Enabled(),
      products: products.map((p) => {
        const versions = specsBy.get(p.id) || [];
        const active = activeSpec(versions, today);
        const draft = versions.find((v) => v.state === "draft") || null;
        return {
          ...p,
          activeSpecVersion: active?.version ?? null,
          draftVersion: draft?.version ?? null,
          gaps: specGaps((draft || active)?.content || {}, p.type),
          rules: ruleCount.get(p.id) || 0,
          upcoming: live.get(p.id) || 0,
          goingAhead: going.get(p.id) || 0,
        };
      }),
      listings: listings.rows,
    });
  }));

  app.get("/api/admin/catalogue/products/:id", ...staff, route(async (req, res) => {
    res.json(await productDetail(pool, id(req.params.id)));
  }));

  app.patch("/api/admin/catalogue/products/:id", ...staff, route(async (req, res) => {
    const patch = productPatch.parse(req.body || {});
    const product = await updateProduct(pool, id(req.params.id), patch);
    await logAudit(req, { action: "catalogue.product.update", entity: "catalogue_product", entityId: product.id, detail: patch });
    invalidatePublic();
    res.json({ product });
  }));

  app.post("/api/admin/catalogue/products/:id/specs", ...staff, route(async (req, res) => {
    const spec = await createDraft(pool, id(req.params.id), by(req));
    await logAudit(req, { action: "catalogue.spec.draft", entity: "catalogue_product", entityId: spec.productId, detail: { version: spec.version } });
    res.status(201).json({ spec });
  }));

  app.put("/api/admin/catalogue/products/:id/specs/:versionId", ...staff, route(async (req, res) => {
    const content = req.body?.content;
    // A specification is a few kilobytes of text; this stops a paste accident,
    // not a determined user.
    if (JSON.stringify(content || {}).length > 200_000) throw new CatalogueError(413, "That specification is too long.");
    const spec = await saveDraft(pool, id(req.params.id), id(req.params.versionId), content);
    res.json({ spec });
  }));

  app.post("/api/admin/catalogue/products/:id/specs/:versionId/publish", ...staff, route(async (req, res) => {
    const effectiveFrom = req.body?.effectiveFrom ? ymdSchema.parse(req.body.effectiveFrom) : null;
    const result = await publishDraft({ productId: id(req.params.id), versionId: id(req.params.versionId), effectiveFrom, by: by(req) });
    await logAudit(req, {
      action: "catalogue.spec.publish", entity: "catalogue_product", entityId: result.spec.productId,
      detail: { version: result.spec.version, effectiveFrom: result.spec.effectiveFrom, departuresMoved: result.departuresMoved },
    });
    invalidatePublic();
    res.json(result);
  }));

  app.post("/api/admin/catalogue/products/:id/rules", ...staff, route(async (req, res) => {
    const rule = await addRule(pool, id(req.params.id), ruleSchema.parse(req.body || {}));
    await logAudit(req, { action: "catalogue.rule.add", entity: "catalogue_product", entityId: rule.productId, detail: rule });
    res.status(201).json({ rule });
  }));

  app.delete("/api/admin/catalogue/products/:id/rules/:ruleId", ...staff, route(async (req, res) => {
    await deleteRule(pool, id(req.params.id), id(req.params.ruleId));
    await logAudit(req, { action: "catalogue.rule.delete", entity: "catalogue_product", entityId: id(req.params.id), detail: { ruleId: req.params.ruleId } });
    res.json({ ok: true });
  }));

  // The calendar view: departures with seat counts, statuses and the instants
  // that decide them. Defaults to the next 8 weeks.
  app.get("/api/admin/catalogue/departures", ...staff, route(async (req, res) => {
    const today = todayIn();
    const from = req.query.from ? ymdSchema.parse(String(req.query.from)) : today;
    const to = req.query.to ? ymdSchema.parse(String(req.query.to)) : shiftDate(from, 55);
    const productId = req.query.productId ? id(req.query.productId) : undefined;
    const [departures, products, listings] = await Promise.all([
      listDepartures(pool, { from, to, productId }),
      listProducts(),
      pool.query(`SELECT id, default_time, nights FROM tour_products
                   WHERE id IN (SELECT legacy_product_id FROM catalogue_products WHERE legacy_product_id IS NOT NULL)`),
    ]);
    const byId = new Map(products.map((p) => [p.id, p]));
    const listingBy = new Map(listings.rows.map((t) => [t.id, t]));
    res.json({
      from, to,
      departures: departures.map((d) => {
        const p = byId.get(d.productId);
        const t = p?.legacyProductId ? listingBy.get(p.legacyProductId) : null;
        const at = departureInstants(d, p, { startTime: t?.default_time, nights: t?.nights });
        return {
          ...d,
          code: p?.code, title: p?.title, type: p?.type, goaheadMin: p?.goaheadMin, maxGroup: p?.maxGroup,
          label: publicDateLabel({ ...d, goaheadMin: p?.goaheadMin }),
          cutoffAt: Number.isFinite(at.cutoffAt) ? new Date(at.cutoffAt).toISOString() : null,
          deadlineAt: Number.isFinite(at.deadlineAt) ? new Date(at.deadlineAt).toISOString() : null,
          startsAt: Number.isFinite(at.startsAt) ? new Date(at.startsAt).toISOString() : null,
        };
      }),
    });
  }));

  app.post("/api/admin/catalogue/departures/:id/run-below-minimum", ...staff, route(async (req, res) => {
    const departure = await runBelowMinimum({ departureId: id(req.params.id), by: by(req), reason: req.body?.reason });
    await logAudit(req, {
      action: "catalogue.departure.run_below_minimum", entity: "catalogue_departure", entityId: departure.id,
      detail: { reason: departure.overrideReason, seatsSold: departure.seatsSold, date: departure.date },
    });
    invalidatePublic();
    res.json({ departure });
  }));

  // Run the generator and the status job now, instead of waiting for the
  // scheduler. Same code and the same flag as the scheduled runs.
  app.post("/api/admin/catalogue/generate", ...staff, route(async (req, res) => {
    const generated = await generateDepartures({ materialise: catalogueV2Enabled() });
    const statuses = await runStatusJob();
    await logAudit(req, { action: "catalogue.generate", entity: "catalogue", entityId: null, detail: { generated, statuses } });
    invalidatePublic();
    res.json({ generated, statuses });
  }));
}
