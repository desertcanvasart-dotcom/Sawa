// Admin → Catalogue and Admin → Calendar (model phase 1).
//
// The catalogue list, the product editor (fields, specification versions with
// draft and publish, calendar rules), a calendar of departures with seat counts
// and statuses, and the "run below minimum" override. The rules behind every
// screen are in shared/catalogue.js; the server side is server/catalogue.js.
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2, RefreshCw, Check } from "lucide-react";
import { apiFetch } from "./supabaseClient";
import { TYPE_LABELS, SPEC_FIELDS, usesDeadline, specGaps } from "../shared/catalogue.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_TONE = { active: "tag-on", held: "tag-warn", retired: "tag-off" };
const DEP_LABEL = { open: "Open", go_ahead: "Going ahead", cancelled_below_minimum: "Cancelled — below minimum", completed: "Completed" };
const DEP_TONE = { open: "", go_ahead: "tag-on", cancelled_below_minimum: "tag-off", completed: "tag-off" };
const FIELD_LABEL = Object.fromEntries(SPEC_FIELDS);
const cairo = (iso, opts) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", ...opts }).format(new Date(iso)) : "—");
const dayLabel = (ymd) => cairo(`${ymd}T12:00:00Z`, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

async function call(path, method = "GET", body) {
  const r = await apiFetch(path, body === undefined ? { method } : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

function Head({ title, sub, action }) {
  return (
    <div className="dash-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {action}
    </div>
  );
}

function Gaps({ gaps }) {
  if (!gaps?.length) return <span className="tag tag-on">Complete</span>;
  return <span className="tag tag-warn" title={gaps.map((g) => FIELD_LABEL[g] || g).join(", ")}>{gaps.length} to complete</span>;
}

// ============================================================ Catalogue list
export function CatalogueSection({ flash }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState(null);

  async function load() {
    try { setErr(""); setData(await call("/admin/catalogue")); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  if (openId) {
    return <CatalogueEditor id={openId} listings={data?.listings || []} products={data?.products || []}
      flash={flash} onClose={() => { setOpenId(null); load(); }} />;
  }

  return (
    <>
      <Head title="Catalogue"
        sub="The fixed products Sawa sells. Each product's specification, calendar and departures are managed here." />
      {err && <div className="auth-error">{err}</div>}
      {data && (
        <p className="field-hint" style={{ marginBottom: 12 }}>
          Public catalogue (<code>catalogue_v2</code>): <b>{data.flag ? "on" : "off"}</b>.
          {data.flag ? " Travellers see active products with a published specification." : " Travellers still see the current Tours & Packages; nothing here is public yet."}
        </p>
      )}
      {data && (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>#</th><th>Product</th><th>Type</th><th>Status</th><th>Specification</th><th>Calendar</th><th>Next 90+ days</th></tr></thead>
            <tbody>
              {data.products.map((p) => (
                <tr key={p.id} className="cat-row-link" onClick={() => setOpenId(p.id)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") setOpenId(p.id); }}>
                  <td className="tnum">{p.catalogueNo}</td>
                  <td>
                    <strong>{p.title}</strong>
                    <div className="field-hint">{p.code} · {p.baseCity}{p.endCity ? ` → ${p.endCity}` : ""}{p.legacyProductId ? "" : " · not linked to a listing"}</div>
                  </td>
                  <td>{TYPE_LABELS[p.type]}</td>
                  <td>
                    <span className={`tag ${STATUS_TONE[p.status]}`}>{p.status}</span>
                    {p.mergedIntoId && <div className="field-hint">merged into #{data.products.find((x) => x.id === p.mergedIntoId)?.catalogueNo}</div>}
                  </td>
                  <td>
                    {p.activeSpecVersion ? `v${p.activeSpecVersion} live` : "none published"}
                    {p.draftVersion ? ` · v${p.draftVersion} draft` : ""}
                    <div><Gaps gaps={p.gaps} /></div>
                  </td>
                  <td>{p.rules ? `${p.rules} rule${p.rules > 1 ? "s" : ""}` : "no dates"}</td>
                  <td className="tnum">{p.upcoming} departures{p.goingAhead ? ` · ${p.goingAhead} going ahead` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ============================================================ Product editor
function CatalogueEditor({ id, listings, products, flash, onClose }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setErr("");
      const d = await call(`/admin/catalogue/products/${id}`);
      setDetail(d);
      setForm({ ...d.product });
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [id]);

  async function saveFields(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const p = form;
      const num = (v) => (v === "" || v == null ? null : Number(v));
      await call(`/admin/catalogue/products/${id}`, "PATCH", {
        title: p.title, type: p.type, baseCity: p.baseCity, endCity: p.endCity || null, status: p.status,
        mergedIntoId: p.status === "retired" ? num(p.mergedIntoId) : null,
        goaheadMin: num(p.goaheadMin), maxGroup: num(p.maxGroup), cutoffHours: num(p.cutoffHours),
        goaheadDeadlineDays: usesDeadline(p.type) ? num(p.goaheadDeadlineDays) : null,
        legacyProductId: p.legacyProductId || null,
      });
      flash("Product saved.");
      await load();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  if (!detail || !form) return <>{err ? <div className="auth-error">{err}</div> : <p>Loading…</p>}</>;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <Head title={`#${detail.product.catalogueNo} ${detail.product.title}`}
        sub={`${detail.product.code} · sold through /${detail.legacyType === "package" ? "package" : "tour"}/${detail.product.slug}`}
        action={<button className="btn-ghost" onClick={onClose}><ArrowLeft size={16} />Back to catalogue</button>} />
      {err && <div className="auth-error">{err}</div>}

      <form className="dash-card" onSubmit={saveFields}>
        <h2>Product</h2>
        <div className="form-grid">
          <label className="field field-full"><span>Title</span><input value={form.title || ""} onChange={set("title")} required /></label>
          <label className="field"><span>Type</span>
            <select value={form.type} onChange={set("type")}>
              {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field"><span>Status</span>
            <select value={form.status} onChange={set("status")}>
              <option value="active">Active: sold and scheduled</option>
              <option value="held">Held: not sold, no new dates</option>
              <option value="retired">Retired</option>
            </select>
          </label>
          <label className="field"><span>Base city</span><input value={form.baseCity || ""} onChange={set("baseCity")} required /></label>
          <label className="field"><span>End city {form.type === "one_way_road_tour" ? "(required)" : "(optional)"}</span>
            <input value={form.endCity || ""} onChange={set("endCity")} required={form.type === "one_way_road_tour"} />
          </label>
          {form.status === "retired" && (
            <label className="field"><span>Merged into</span>
              <select value={form.mergedIntoId || ""} onChange={set("mergedIntoId")}>
                <option value="">Not merged</option>
                {products.filter((x) => x.id !== detail.product.id && x.status !== "retired").map((x) => (
                  <option key={x.id} value={x.id}>#{x.catalogueNo} {x.title}</option>
                ))}
              </select>
              <em className="field-hint">Its old page redirects (301) to the product it was merged into.</em>
            </label>
          )}
          <label className="field"><span>GoAhead minimum</span><input type="number" min="1" max="12" value={form.goaheadMin ?? ""} onChange={set("goaheadMin")} /></label>
          <label className="field"><span>Maximum group</span><input type="number" min="1" max="12" value={form.maxGroup ?? ""} onChange={set("maxGroup")} /></label>
          <label className="field"><span>Cut-off (hours before departure)</span><input type="number" min="0" value={form.cutoffHours ?? ""} onChange={set("cutoffHours")} /></label>
          {usesDeadline(form.type) && (
            <label className="field"><span>GoAhead deadline (days before departure)</span>
              <input type="number" min="1" max="365" value={form.goaheadDeadlineDays ?? ""} onChange={set("goaheadDeadlineDays")} required />
              <em className="field-hint">Below the minimum at this point, the departure is cancelled and nobody is charged.</em>
            </label>
          )}
          <label className="field field-full"><span>Sold through listing</span>
            <select value={form.legacyProductId || ""} onChange={set("legacyProductId")}>
              <option value="">Not linked: not bookable</option>
              {listings.map((l) => <option key={l.id} value={l.id}>{l.title} ({l.id})</option>)}
            </select>
            <em className="field-hint">The price, photos and booking still come from this listing in this phase.</em>
          </label>
        </div>
        <div className="cat-actions"><button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save product"}</button></div>
      </form>

      <SpecPanel detail={detail} reload={load} flash={flash} />
      <RulesPanel detail={detail} reload={load} flash={flash} />
    </>
  );
}

// ------------------------------------------------------------ specification
function SpecPanel({ detail, reload, flash }) {
  const { product, specs, activeSpecId } = detail;
  const draft = specs.find((s) => s.state === "draft") || null;
  const [err, setErr] = useState("");

  async function newDraft() {
    try { setErr(""); await call(`/admin/catalogue/products/${product.id}/specs`, "POST", {}); flash("New draft created."); await reload(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div className="dash-card" style={{ marginTop: 16 }}>
      <div className="dash-card-head">
        <h2>Specification</h2>
        {!draft && <button className="btn-ghost" onClick={newDraft}><Plus size={16} />New version</button>}
      </div>
      <p className="field-hint">A published version is fixed. Departures that already have seats sold keep the version they were sold under.</p>
      {err && <div className="auth-error">{err}</div>}
      <table className="dash-table" style={{ marginBottom: 12 }}>
        <thead><tr><th>Version</th><th>State</th><th>Takes effect</th><th>Completeness</th></tr></thead>
        <tbody>
          {specs.map((s) => (
            <tr key={s.id}>
              <td>v{s.version}{s.id === activeSpecId ? " (live)" : ""}</td>
              <td>{s.state === "draft" ? "Draft" : "Published"}</td>
              <td>{s.effectiveFrom ? dayLabel(s.effectiveFrom) : "—"}</td>
              <td><Gaps gaps={s.gaps} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft && <DraftEditor key={draft.id} product={product} draft={draft} reload={reload} flash={flash} />}
    </div>
  );
}

const lines = (v) => (Array.isArray(v) ? v.join("\n") : "");
const toLines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);

function DraftEditor({ product, draft, reload, flash }) {
  const c = draft.content || {};
  const [f, setF] = useState(() => ({
    itinerary: JSON.stringify(c.itinerary || [], null, 2),
    startTime: c.startTime || "", duration: c.duration || "",
    inclusions: lines(c.inclusions), exclusions: lines(c.exclusions),
    band46: c.vehicleByBand?.["4-6"] || "", band79: c.vehicleByBand?.["7-9"] || "", band1012: c.vehicleByBand?.["10-12"] || "",
    guideLanguages: (c.guideLanguages || []).join(", "), meals: c.meals || "",
    pickupArea: c.pickupArea || "", pickupWindow: c.pickupWindow || "",
    addons: (c.addons || []).map((a) => `${a.name}${a.price != null ? ` | ${a.price}` : ""}`).join("\n"),
    noAddons: c.noAddons === true,
    rooms: (c.roomCategories || []).map((r) => `${r.name}${r.occupancy?.length ? ` | ${r.occupancy.join(",")}` : ""}`).join("\n"),
  }));
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  function build() {
    let itinerary;
    try { itinerary = JSON.parse(f.itinerary || "[]"); } catch { throw new Error("The itinerary isn't valid JSON."); }
    if (!Array.isArray(itinerary)) throw new Error("The itinerary must be a list.");
    const nz = (s) => (String(s || "").trim() || null);
    return {
      ...c,
      itinerary,
      startTime: nz(f.startTime), duration: nz(f.duration),
      inclusions: toLines(f.inclusions), exclusions: toLines(f.exclusions),
      vehicleByBand: { "4-6": nz(f.band46), "7-9": nz(f.band79), "10-12": nz(f.band1012) },
      guideLanguages: String(f.guideLanguages || "").split(",").map((x) => x.trim()).filter(Boolean),
      meals: nz(f.meals), pickupArea: nz(f.pickupArea), pickupWindow: nz(f.pickupWindow),
      addons: toLines(f.addons).map((l) => {
        const [name, price] = l.split("|").map((x) => x.trim());
        return { name, price: price === undefined || price === "" ? null : Number(price) };
      }),
      noAddons: !!f.noAddons,
      roomCategories: usesDeadline(product.type) ? toLines(f.rooms).map((l) => {
        const [name, occ] = l.split("|").map((x) => x.trim());
        return { name, occupancy: String(occ || "").split(",").map(Number).filter((n) => n >= 1 && n <= 4) };
      }) : [],
    };
  }

  const liveGaps = useMemo(() => { try { return specGaps(build(), product.type); } catch { return null; } }, [f]);

  async function save(publish) {
    setBusy(true);
    try {
      setErr("");
      await call(`/admin/catalogue/products/${product.id}/specs/${draft.id}`, "PUT", { content: build() });
      if (publish) {
        const r = await call(`/admin/catalogue/products/${product.id}/specs/${draft.id}/publish`, "POST", { effectiveFrom: effectiveFrom || null });
        flash(`Version ${r.spec.version} published${r.departuresMoved ? `; ${r.departuresMoved} unsold departure(s) moved onto it` : ""}.`);
      } else {
        flash("Draft saved.");
      }
      await reload();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const source = draft.sources?.copiedFrom;
  return (
    <div className="cat-draft">
      <h3>Draft v{draft.version}</h3>
      {source && <p className="field-hint">Pre-filled from {source}. Fields: {draft.sources.fields || "—"}. Check every one before publishing.</p>}
      {draft.content?.reference && (
        <p className="field-hint">For reference, the listing says: {Object.entries(draft.content.reference).map(([k, v]) => `${k} “${v}”`).join("; ")}.</p>
      )}
      {liveGaps && liveGaps.length > 0 && (
        <p className="field-hint">To complete: {liveGaps.map((g) => FIELD_LABEL[g] || g).join(", ")}.</p>
      )}
      {err && <div className="auth-error">{err}</div>}
      <div className="form-grid">
        <label className="field"><span>Start time</span><input value={f.startTime} onChange={set("startTime")} placeholder="to complete, e.g. 08:00" /></label>
        <label className="field"><span>Duration</span><input value={f.duration} onChange={set("duration")} placeholder="to complete" /></label>
        <label className="field"><span>Pickup area</span><textarea rows={2} value={f.pickupArea} onChange={set("pickupArea")} placeholder="to complete" /></label>
        <label className="field"><span>Pickup window</span><input value={f.pickupWindow} onChange={set("pickupWindow")} placeholder="to complete, e.g. 07:15–07:45" /></label>
        <label className="field"><span>Inclusions (one per line)</span><textarea rows={5} value={f.inclusions} onChange={set("inclusions")} placeholder="to complete" /></label>
        <label className="field"><span>Exclusions (one per line)</span><textarea rows={5} value={f.exclusions} onChange={set("exclusions")} placeholder="to complete" /></label>
        <label className="field"><span>Vehicle, 4–6 travellers</span><input value={f.band46} onChange={set("band46")} placeholder="to complete" /></label>
        <label className="field"><span>Vehicle, 7–9 travellers</span><input value={f.band79} onChange={set("band79")} placeholder="to complete" /></label>
        <label className="field"><span>Vehicle, 10–12 travellers</span><input value={f.band1012} onChange={set("band1012")} placeholder="to complete" /></label>
        <label className="field"><span>Guide languages (comma-separated)</span><input value={f.guideLanguages} onChange={set("guideLanguages")} placeholder="to complete, e.g. English, French" /></label>
        <label className="field field-full"><span>Meals</span><input value={f.meals} onChange={set("meals")} placeholder="to complete, e.g. Lunch included" /></label>
        <label className="field field-full"><span>Listed paid add-ons (one per line: name | price in EUR)</span>
          <textarea rows={3} value={f.addons} onChange={set("addons")} placeholder="to complete" />
          <span className="cat-check"><input type="checkbox" checked={f.noAddons} onChange={set("noAddons")} /> This product has no paid add-ons</span>
        </label>
        {usesDeadline(product.type) && (
          <label className="field field-full"><span>Room or cabin categories (one per line: name | occupancies, e.g. Standard cabin | 1,2,3)</span>
            <textarea rows={3} value={f.rooms} onChange={set("rooms")} placeholder="to complete" />
          </label>
        )}
        <label className="field field-full"><span>Itinerary with timings (JSON list)</span>
          <textarea rows={8} className="cat-mono" value={f.itinerary} onChange={set("itinerary")} spellCheck={false} />
          <em className="field-hint">One entry per stop or day, e.g. {'{"time": "08:00", "title": "Pickup", "description": "…"}'}.</em>
        </label>
      </div>
      <div className="cat-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <button className="btn-ghost" disabled={busy} onClick={() => save(false)}>Save draft</button>
        <label className="field" style={{ margin: 0 }}><span>Takes effect</span>
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={busy} onClick={() => save(true)}>
          <Check size={16} />Publish{effectiveFrom ? "" : " today"}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ calendar rules
function RulesPanel({ detail, reload, flash }) {
  const { product, rules } = detail;
  const blank = { kind: usesDeadline(product.type) && product.type === "cruise" ? "dates" : "weekdays", weekdays: [], intervalWeeks: 1, anchorDate: "", dates: "", activeFrom: "", activeTo: "", note: "" };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState("");

  async function add(e) {
    e.preventDefault();
    try {
      setErr("");
      await call(`/admin/catalogue/products/${product.id}/rules`, "POST", {
        kind: f.kind,
        weekdays: f.kind === "weekdays" ? f.weekdays : undefined,
        intervalWeeks: f.kind === "weekdays" ? Number(f.intervalWeeks) || 1 : undefined,
        anchorDate: f.kind === "weekdays" && Number(f.intervalWeeks) > 1 ? f.anchorDate || null : null,
        dates: f.kind === "dates" ? String(f.dates).split(/[\s,]+/).filter(Boolean) : undefined,
        activeFrom: f.activeFrom, activeTo: f.activeTo || null, note: f.note || null,
      });
      setF(blank);
      flash("Calendar rule added. New departures appear on the next generator run.");
      await reload();
    } catch (e2) { setErr(e2.message); }
  }
  async function remove(r) {
    if (!window.confirm("Remove this rule? Departures it already created stay as they are.")) return;
    try { await call(`/admin/catalogue/products/${product.id}/rules/${r.id}`, "DELETE"); flash("Rule removed."); await reload(); }
    catch (e) { setErr(e.message); }
  }
  const toggleDay = (d) => setF({ ...f, weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d].sort() });

  const describe = (r) => r.kind === "dates"
    ? `${r.dates.length} date${r.dates.length === 1 ? "" : "s"}: ${r.dates.slice(0, 6).map(dayLabel).join(", ")}${r.dates.length > 6 ? "…" : ""}`
    : `${r.weekdays.map((d) => WEEKDAYS[d]).join(", ")}${r.intervalWeeks > 1 ? `, every ${r.intervalWeeks} weeks from ${dayLabel(r.anchorDate)}` : ", every week"}`;

  return (
    <div className="dash-card" style={{ marginTop: 16 }}>
      <h2>Calendar</h2>
      <p className="field-hint">
        {product.status === "active" ? "The generator creates departures from these rules" : `This product is ${product.status}: it generates no departures`}
        {" "}for {usesDeadline(product.type) ? "365" : "90"} days ahead.
      </p>
      {err && <div className="auth-error">{err}</div>}
      {rules.length ? (
        <table className="dash-table" style={{ marginBottom: 12 }}>
          <thead><tr><th>Runs</th><th>From</th><th>Until</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{describe(r)}</td><td>{dayLabel(r.activeFrom)}</td><td>{r.activeTo ? dayLabel(r.activeTo) : "open-ended"}</td>
                <td>{r.note || ""}</td>
                <td className="row-actions"><button className="icon-btn danger" title="Remove rule" onClick={() => remove(r)}><Trash2 size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="field-hint">No rules yet: no departures will be created.{product.type === "cruise" ? " Enter the ship's sailing days as dates." : ""}</p>}

      <form onSubmit={add} className="form-grid">
        <label className="field"><span>Rule</span>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="weekdays">Weekdays</option>
            <option value="dates">Specific dates (e.g. sailing days)</option>
          </select>
        </label>
        {f.kind === "weekdays" ? (
          <>
            <div className="field"><span>Days</span>
              <div className="cat-days">
                {WEEKDAYS.map((w, i) => (
                  <label key={w} className="cat-check"><input type="checkbox" checked={f.weekdays.includes(i)} onChange={() => toggleDay(i)} /> {w}</label>
                ))}
              </div>
            </div>
            <label className="field"><span>Every</span>
              <select value={f.intervalWeeks} onChange={(e) => setF({ ...f, intervalWeeks: e.target.value })}>
                <option value={1}>week</option><option value={2}>2 weeks (fortnightly)</option><option value={3}>3 weeks</option><option value={4}>4 weeks</option>
              </select>
            </label>
            {Number(f.intervalWeeks) > 1 && (
              <label className="field"><span>Counting from (a date it runs)</span><input type="date" value={f.anchorDate} onChange={(e) => setF({ ...f, anchorDate: e.target.value })} required /></label>
            )}
          </>
        ) : (
          <label className="field field-full"><span>Dates (YYYY-MM-DD, separated by spaces, commas or new lines)</span>
            <textarea rows={3} value={f.dates} onChange={(e) => setF({ ...f, dates: e.target.value })} required />
          </label>
        )}
        <label className="field"><span>Active from</span><input type="date" value={f.activeFrom} onChange={(e) => setF({ ...f, activeFrom: e.target.value })} required /></label>
        <label className="field"><span>Active until (optional)</span><input type="date" value={f.activeTo} onChange={(e) => setF({ ...f, activeTo: e.target.value })} /></label>
        <label className="field field-full"><span>Note (optional)</span><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} /></label>
        <div className="cat-actions field-full"><button className="btn-primary"><Plus size={16} />Add rule</button></div>
      </form>
    </div>
  );
}

// ============================================================ Calendar view
export function CalendarSection({ flash }) {
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [err, setErr] = useState("");
  const [from, setFrom] = useState("");
  const [productId, setProductId] = useState("");
  const [overriding, setOverriding] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setErr("");
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (productId) q.set("productId", productId);
      setData(await call(`/admin/catalogue/departures?${q}`));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [from, productId]);
  // The product filter is a convenience: if it can't load, say so and keep the calendar.
  useEffect(() => { call("/admin/catalogue").then((j) => setProducts(j.products)).catch((e) => setErr(e.message)); }, []);

  async function generate() {
    setBusy(true);
    try {
      const r = await call("/admin/catalogue/generate", "POST", {});
      flash(`Generator: ${r.generated.created} created, ${r.generated.adopted} adopted, ${r.generated.materialised} made bookable. Statuses: ${r.statuses.go_ahead} going ahead, ${r.statuses.cancelled_below_minimum} cancelled, ${r.statuses.completed} completed.`);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function runBelow(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await call(`/admin/catalogue/departures/${overriding.id}/run-below-minimum`, "POST", { reason });
      flash(`${overriding.code} on ${dayLabel(overriding.date)} will run below its minimum. Recorded with your reason.`);
      setOverriding(null); setReason("");
      await load();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  const byDate = useMemo(() => {
    const m = new Map();
    for (const d of data?.departures || []) {
      if (!m.has(d.date)) m.set(d.date, []);
      m.get(d.date).push(d);
    }
    return [...m.entries()];
  }, [data]);

  return (
    <>
      <Head title="Calendar" sub="Departures created from the catalogue calendar, with seats sold and where each stands."
        action={<button className="btn-ghost" onClick={generate} disabled={busy}><RefreshCw size={16} />Run generator now</button>} />
      {err && <div className="auth-error">{err}</div>}
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <label className="field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>Product</span>
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All products</option>
            {products.map((p) => <option key={p.id} value={p.id}>#{p.catalogueNo} {p.title}</option>)}
          </select>
        </label>
      </div>

      {overriding && (
        <form className="dash-card" onSubmit={runBelow} style={{ marginBottom: 12 }}>
          <h2>Run below minimum</h2>
          <p>{overriding.code} {overriding.title}, {dayLabel(overriding.date)}: {overriding.seatsSold} of {overriding.goaheadMin} seats sold.
            It will go ahead and the operator is paid at the 4–6 band. Your name and reason are recorded.</p>
          <label className="field field-full"><span>Reason</span><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} /></label>
          <div className="cat-actions">
            <button type="button" className="btn-ghost" onClick={() => { setOverriding(null); setReason(""); }}>Cancel</button>
            <button className="btn-primary" disabled={busy}>Run it</button>
          </div>
        </form>
      )}

      {data && (byDate.length ? (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>Date</th><th>Product</th><th>Seats</th><th>Status</th><th>Decided at</th><th></th></tr></thead>
            <tbody>
              {byDate.map(([date, deps]) => deps.map((d, i) => (
                <tr key={d.id}>
                  <td>{i === 0 ? <strong>{dayLabel(date)}</strong> : ""}</td>
                  <td>{d.code} {d.title}
                    <div className="field-hint">{d.origin === "adopted" ? "existing date, old rules" : d.legacyDepartureId ? "bookable" : "not bookable yet"}</div>
                  </td>
                  <td className="tnum">{d.seatsSold} / {d.maxGroup}<div className="field-hint">{d.label}</div></td>
                  <td>
                    <span className={`tag ${DEP_TONE[d.status]}`}>{DEP_LABEL[d.status]}</span>
                    {d.runBelowMinimum && <div className="field-hint" title={d.overrideReason}>run below minimum by {d.overrideBy}</div>}
                  </td>
                  <td>{usesDeadline(d.type) ? `Deadline ${cairo(d.deadlineAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                    : `Cut-off ${cairo(d.cutoffAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}</td>
                  <td className="row-actions">
                    {(d.status === "open" || (d.status === "cancelled_below_minimum" && !d.seatsSold)) && d.seatsSold < d.goaheadMin && (
                      <button className="btn-ghost sm" onClick={() => { setOverriding(d); setReason(""); }}>Run below minimum</button>
                    )}
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      ) : <div className="dash-empty">No departures in this range. Add calendar rules in the Catalogue, then run the generator.</div>)}
    </>
  );
}
