// Admin → Operators, Roster and Rate card (model phase 2), and the operator
// panel on a calendar departure (assignment, manifest, expected amount).
//
// The rules behind every screen are in shared/operators.js; the server side is
// server/operators.js, roster.js, rates.js and assignments.js. Nothing here
// charges, refunds or pays: the expected amount is shown, never paid.
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Upload, Check, X, AlertTriangle } from "lucide-react";
import { apiFetch } from "./supabaseClient";
import {
  DOCUMENT_KINDS, DOCUMENT_LABELS, STRIKE_KINDS, STRIKE_LABELS, STRIKE_FLAG_AT, ACK_HOURS,
} from "../shared/operators.js";
import {
  DEFAULT_POOL_TIERS, DEFAULT_COMMISSION_PCT, COST_BASES, COST_BASIS_LABELS, poolRateError, poolRateTable, tierPriceEur, tierPriceLine,
} from "../shared/pool-model.js";
import { TYPE_LABELS } from "../shared/catalogue.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_TONE = { pending: "tag-warn", active: "tag-on", suspended: "tag-off", removed: "tag-off" };
const STATUS_LABEL = { pending: "Pending", active: "Active", suspended: "Suspended", removed: "Removed" };
const ASSIGN_LABEL = { offered: "Offered, awaiting acknowledgement", acknowledged: "Acknowledged", expired: "Not acknowledged in time" };
const egp = (n) => (n == null ? "—" : `EGP ${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const dayLabel = (ymd) => (ymd ? new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T12:00:00Z`)) : "—");
const stamp = (iso) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "—");
const thisMonth = () => new Date().toISOString().slice(0, 7);
const nextMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); };

async function call(path, method = "GET", body) {
  const r = await apiFetch(path, body === undefined ? { method } : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "That didn't work. Please try again."), { problems: j.problems });
  return j;
}

const readFile = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(new Error("Couldn't read that file."));
  fr.readAsDataURL(file);
});

function Head({ title, sub, action }) {
  return (
    <div className="dash-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {action}
    </div>
  );
}

function DocGaps({ gaps }) {
  if (!gaps?.length) return <span className="tag tag-on">All current</span>;
  return (
    <span className="tag tag-warn" title={gaps.map((g) => `${DOCUMENT_LABELS[g.kind]}: ${g.problem}`).join(", ")}>
      {gaps.length} missing or expired
    </span>
  );
}

function StrikeFlag({ n }) {
  if (!n) return <span className="field-hint">0</span>;
  return n >= STRIKE_FLAG_AT
    ? <span className="tag tag-off" title="Flagged for fewer roster days. Removal is an admin decision."><AlertTriangle size={12} /> {n} in 90 days</span>
    : <span className="tag tag-warn">{n} in 90 days</span>;
}

// ============================================================ Operators
export function OperatorsSection({ flash, isSuperAdmin }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [legalName, setLegalName] = useState("");

  async function load() {
    try { setErr(""); setData(await call("/admin/operators")); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    try {
      const { operator } = await call("/admin/operators", "POST", { legalName });
      flash(`${operator.legalName} added as pending. Upload its four documents, then activate it.`);
      setAdding(false); setLegalName("");
      setOpenId(operator.id);
    } catch (e2) { setErr(e2.message); }
  }

  if (openId) {
    return <OperatorEditor id={openId} products={data?.products || []} agencies={data?.agencies || []}
      flash={flash} isSuperAdmin={isSuperAdmin} onClose={() => { setOpenId(null); load(); }} />;
  }

  return (
    <>
      <Head title="Operators"
        sub="Licensed operators who run catalog departures. Only active operators with current documents and product approval can be rostered."
        action={<button className="btn-primary" onClick={() => setAdding(true)}>Add operator</button>} />
      {err && <div className="auth-error">{err}</div>}
      {adding && (
        <form className="dash-card" onSubmit={create} style={{ marginBottom: 12 }}>
          <label className="field field-full"><span>Legal name</span>
            <input value={legalName} onChange={(e) => setLegalName(e.target.value)} required maxLength={200} autoFocus />
          </label>
          <div className="cat-actions">
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn-primary">Add</button>
          </div>
        </form>
      )}
      {data && (data.operators.length ? (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>Operator</th><th>Status</th><th>Documents</th><th>Approved products</th><th>Strikes</th></tr></thead>
            <tbody>
              {data.operators.map((o) => (
                <tr key={o.id} className="cat-row-link" tabIndex={0} onClick={() => setOpenId(o.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") setOpenId(o.id); }}>
                  <td><strong>{o.legalName}</strong>{o.tradingName && <div className="field-hint">{o.tradingName}</div>}</td>
                  <td><span className={`tag ${STATUS_TONE[o.status]}`}>{STATUS_LABEL[o.status]}</span>
                    {o.statusReason && <div className="field-hint">{o.statusReason.replace("document_expired:", "expired: ").replace(/_/g, " ")}</div>}</td>
                  <td><DocGaps gaps={o.documentGaps} /></td>
                  <td className="tnum">{o.approvedProductIds.length}</td>
                  <td><StrikeFlag n={o.strikes90} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="dash-empty">No operators yet. Migration 049 creates one for each operator agency; add others here.</div>)}
    </>
  );
}

const OPERATOR_TEXT_FIELDS = [
  ["legalName", "Legal name"], ["tradingName", "Trading name"],
  ["tourismLicenseNo", "Ministry of Tourism license no."], ["etaaNo", "ETAA membership no."],
  // Printed for travelers where this operator is named as seller (payment
  // request, receipt, voucher, booking page). Empty: the Ministry license no.
  ["travellerLicenceNo", "License no. shown to travelers (as seller)"],
  ["commercialRegistrationNo", "Commercial registration no."], ["taxRegistrationNo", "Tax registration no."],
  ["email", "Email (assignment notices)"], ["phone", "Phone"], ["whatsapp", "WhatsApp (stored; not used yet)"],
];

function OperatorEditor({ id, products, agencies, flash, isSuperAdmin, onClose }) {
  const [d, setD] = useState(null);
  const [form, setForm] = useState({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [docForm, setDocForm] = useState(null);
  const [strike, setStrike] = useState({ kind: "service_failure", note: "" });
  const [login, setLogin] = useState({ email: "", fullName: "", role: "operator_owner" });
  const [tempPw, setTempPw] = useState(null);

  async function load() {
    try {
      setErr("");
      const j = await call(`/admin/operators/${id}`);
      setD(j);
      setForm({ ...Object.fromEntries(OPERATOR_TEXT_FIELDS.map(([k]) => [k, j.operator[k] || ""])), agencyId: j.operator.agencyId || "", notes: j.operator.notes || "" });
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [id]);

  const run = async (fn, msg) => {
    setBusy(true); setErr("");
    try { await fn(); if (msg) flash(msg); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (!d) return <>{err ? <div className="auth-error">{err}</div> : <div className="dash-empty">Loading…</div>}</>;
  const op = d.operator;
  const current = new Map(d.documents.filter((x) => !x.supersededAt).map((x) => [x.kind, x]));

  return (
    <>
      <Head title={op.legalName}
        sub={<><span className={`tag ${STATUS_TONE[op.status]}`}>{STATUS_LABEL[op.status]}</span>{op.statusChangedBy && <> · changed by {op.statusChangedBy} {stamp(op.statusChangedAt)}</>}</>}
        action={<button className="btn-ghost" onClick={onClose}><ArrowLeft size={16} />All operators</button>} />
      {err && <div className="auth-error">{err}</div>}

      <div className="dash-card" style={{ marginBottom: 12 }}>
        <h2>Status</h2>
        <p className="field-hint">Activating needs all four documents current. The daily check suspends an operator whose document expires and reactivates it when you upload a valid replacement. Removal is always a manual decision.</p>
        <div className="cat-actions">
          {op.activationBlocked && <div className="auth-error" role="status">{op.activationBlocked}</div>}
          {op.status !== "active" && op.status !== "removed" && !op.activationBlocked && <button className="btn-primary" disabled={busy} onClick={() => run(() => call(`/admin/operators/${id}/status`, "POST", { status: "active" }), "Operator activated.")}>Activate</button>}
          {op.status === "active" && <button className="btn-ghost" disabled={busy} onClick={() => { const reason = window.prompt("Reason for suspending"); if (reason) run(() => call(`/admin/operators/${id}/status`, "POST", { status: "suspended", reason }), "Operator suspended."); }}>Suspend</button>}
          {op.status !== "removed" && <button className="btn-ghost" disabled={busy} onClick={() => { const reason = window.prompt("Reason for removing this operator from the roster"); if (reason) run(() => call(`/admin/operators/${id}/status`, "POST", { status: "removed", reason }), "Operator removed."); }}>Remove</button>}
          {op.status === "removed" && <button className="btn-ghost" disabled={busy} onClick={() => run(() => call(`/admin/operators/${id}/status`, "POST", { status: "pending" }), "Operator moved back to pending.")}>Reinstate as pending</button>}
        </div>
      </div>

      <form className="dash-card" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/operators/${id}`, "PATCH", { ...form, agencyId: form.agencyId || null }), "Saved."); }}>
        <h2>Record</h2>
        <div className="form-grid">
          {OPERATOR_TEXT_FIELDS.map(([k, label]) => (
            <label className="field" key={k}><span>{label}</span>
              <input value={form[k] || ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} required={k === "legalName"} />
            </label>
          ))}
          <label className="field"><span>Linked agency record</span>
            <select value={form.agencyId || ""} onChange={(e) => setForm({ ...form, agencyId: e.target.value })}>
              <option value="">None</option>
              {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="field field-full"><span>Notes</span><textarea rows={2} value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        </div>
        <div className="cat-actions"><button className="btn-primary" disabled={busy}>Save</button></div>
      </form>

      <div className="dash-card" style={{ marginBottom: 12 }}>
        <h2>Documents</h2>
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>Document</th><th>Number</th><th>Expires</th><th>File</th><th></th></tr></thead>
            <tbody>
              {DOCUMENT_KINDS.map((kind) => {
                const doc = current.get(kind);
                const gap = d.documentGaps.find((g) => g.kind === kind);
                return (
                  <tr key={kind}>
                    <td>{DOCUMENT_LABELS[kind]}</td>
                    <td>{doc?.number || "—"}</td>
                    <td>{doc ? dayLabel(doc.expiresOn) : "—"} {gap && <span className="tag tag-warn">{gap.problem}</span>}</td>
                    <td>{doc?.hasFile ? <button className="btn-ghost sm" onClick={() => call(`/admin/operators/${id}/documents/${doc.id}/file`).then((j) => window.open(j.url, "_blank", "noopener")).catch((e) => setErr(e.message))}>Open</button> : "—"}</td>
                    <td className="row-actions"><button className="btn-ghost sm" onClick={() => setDocForm({ kind, number: "", expiresOn: "", file: null })}><Upload size={14} />{doc ? "Replace" : "Add"}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {docForm && (
          <form onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const body = { kind: docForm.kind, number: docForm.number || null, expiresOn: docForm.expiresOn };
              if (docForm.file) { body.dataUrl = await readFile(docForm.file); body.filename = docForm.file.name; }
              const r = await call(`/admin/operators/${id}/documents`, "POST", body);
              setDocForm(null);
              if (r.reactivated) flash("Document saved. All documents are current again, so the operator is active.");
            }, "Document saved.");
          }}>
            <h3>{DOCUMENT_LABELS[docForm.kind]}</h3>
            <div className="form-grid">
              <label className="field"><span>Number</span><input value={docForm.number} onChange={(e) => setDocForm({ ...docForm, number: e.target.value })} /></label>
              <label className="field"><span>Expires on</span><input type="date" required value={docForm.expiresOn} onChange={(e) => setDocForm({ ...docForm, expiresOn: e.target.value })} /></label>
              <label className="field"><span>File (PDF or image)</span><input type="file" accept="application/pdf,image/*" onChange={(e) => setDocForm({ ...docForm, file: e.target.files?.[0] || null })} /></label>
            </div>
            <div className="cat-actions">
              <button type="button" className="btn-ghost" onClick={() => setDocForm(null)}>Cancel</button>
              <button className="btn-primary" disabled={busy}>Save document</button>
            </div>
          </form>
        )}
      </div>

      <BankCard operatorId={id} legalName={op.legalName} flash={flash} />

      <ApprovalsCard id={id} products={products} approved={d.approvedProductIds} run={run} busy={busy} />

      <div className="dash-card" style={{ marginBottom: 12 }}>
        <h2>Strikes <StrikeFlag n={d.strikes90} /></h2>
        <p className="field-hint">A missed acknowledgement is recorded automatically. {STRIKE_FLAG_AT} strikes in 90 days flags the operator for fewer roster days; removal is your decision.</p>
        {d.strikes.length ? (
          <div className="table-wrap">
            <table className="dash-table">
              <thead><tr><th>When</th><th>Kind</th><th>Note</th><th>By</th><th></th></tr></thead>
              <tbody>
                {d.strikes.map((s) => (
                  <tr key={s.id} style={s.voidedAt ? { opacity: 0.5 } : undefined}>
                    <td>{stamp(s.createdAt)}</td>
                    <td>{STRIKE_LABELS[s.kind]}</td>
                    <td>{s.note}{s.voidedAt && <div className="field-hint">Voided by {s.voidedBy}: {s.voidReason}</div>}</td>
                    <td>{s.createdBy || "system"}</td>
                    <td className="row-actions">{!s.voidedAt && <button className="btn-ghost sm" onClick={() => { const reason = window.prompt("Why void this strike?"); if (reason) run(() => call(`/admin/operator-strikes/${s.id}/void`, "POST", { reason }), "Strike voided."); }}>Void</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="field-hint">No strikes.</p>}
        <form onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/operators/${id}/strikes`, "POST", strike).then(() => setStrike({ ...strike, note: "" })), "Strike recorded."); }}>
          <div className="form-grid">
            <label className="field"><span>Kind</span>
              <select value={strike.kind} onChange={(e) => setStrike({ ...strike, kind: e.target.value })}>
                {STRIKE_KINDS.filter((k) => k !== "missed_acknowledgement").map((k) => <option key={k} value={k}>{STRIKE_LABELS[k]}</option>)}
              </select>
            </label>
            <label className="field"><span>What happened</span><input value={strike.note} onChange={(e) => setStrike({ ...strike, note: e.target.value })} required minLength={3} /></label>
          </div>
          <div className="cat-actions"><button className="btn-ghost" disabled={busy}>Record strike</button></div>
        </form>
      </div>

      <div className="dash-card">
        <h2>Portal logins</h2>
        {d.users.length ? <ul>{d.users.map((u) => <li key={u.id}>{u.email} · {u.role === "operator_owner" ? "Owner" : "Staff"} · {u.status}</li>)}</ul> : <p className="field-hint">No logins yet.</p>}
        {tempPw && <div className="dash-flash" role="status">Temporary password for {tempPw.email}: <code>{tempPw.password}</code>. Share it once; they change it at first sign-in.</div>}
        {isSuperAdmin ? (
          <form onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await call(`/admin/operators/${id}/users`, "POST", login);
              setTempPw({ email: login.email, password: r.tempPassword });
              setLogin({ email: "", fullName: "", role: "operator_owner" });
            }, "Login created.");
          }}>
            <div className="form-grid">
              <label className="field"><span>Email</span><input type="email" required value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={login.fullName} onChange={(e) => setLogin({ ...login, fullName: e.target.value })} /></label>
              <label className="field"><span>Role</span>
                <select value={login.role} onChange={(e) => setLogin({ ...login, role: e.target.value })}>
                  <option value="operator_owner">Owner</option><option value="operator_staff">Staff</option>
                </select>
              </label>
            </div>
            <div className="cat-actions"><button className="btn-ghost" disabled={busy}>Create login</button></div>
          </form>
        ) : <p className="field-hint">A super admin creates operator logins.</p>}
      </div>
    </>
  );
}

function ApprovalsCard({ id, products, approved, run, busy }) {
  const [sel, setSel] = useState(new Set(approved));
  useEffect(() => { setSel(new Set(approved)); }, [approved.join(",")]);
  const toggle = (pid) => { const n = new Set(sel); n.has(pid) ? n.delete(pid) : n.add(pid); setSel(n); };
  return (
    <div className="dash-card" style={{ marginBottom: 12 }}>
      <h2>Approved products</h2>
      <p className="field-hint">The products this operator may be rostered on.</p>
      <div className="form-grid">
        {products.filter((p) => p.status !== "retired").map((p) => (
          <label key={p.id} className="field-check">
            <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} /> #{p.catalogue_no} {p.title}
          </label>
        ))}
      </div>
      <div className="cat-actions">
        <button className="btn-primary" disabled={busy} onClick={() => run(() => call(`/admin/operators/${id}/approvals`, "PUT", { productIds: [...sel] }), "Approvals saved.")}>Save approvals</button>
      </div>
    </div>
  );
}

// ============================================================ Roster
export function RosterSection({ flash }) {
  const [month, setMonth] = useState(nextMonth());
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setErr(""); setData(await call(`/admin/roster?month=${month}`)); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [month]);

  const run = async (fn, msg) => {
    setBusy(true); setErr(""); setProblems([]);
    try { const r = await fn(); if (msg) flash(typeof msg === "function" ? msg(r) : msg); await load(); } catch (e) { setErr(e.message); setProblems(e.problems || []); } finally { setBusy(false); }
  };

  const eligible = (productId) => (data?.operators || []).filter((o) => o.status === "active" && o.approvedProductIds.includes(productId));
  const opName = useMemo(() => new Map((data?.operators || []).map((o) => [o.id, o])), [data]);
  const planOf = (productId, weekday) => data?.plan.find((l) => l.productId === productId && l.weekday === weekday)?.operatorId || "";

  return (
    <>
      <Head title="Roster"
        sub="Who runs each catalog product on each date. Plan the weekdays, build the month, adjust single dates, then publish by the 15th of the month before."
        action={<input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} />} />
      {err && <div className="auth-error">{err}{problems.length > 0 && <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}</div>}
      {data && (
        <>
          <p className="field-hint" style={{ marginBottom: 12 }}>
            {data.state === "published"
              ? <>Published {stamp(data.publishedAt)} by {data.publishedBy}. Operators can see their own dates.</>
              : <>Draft. Publish by <b>{dayLabel(data.deadline)}</b>.{data.late && <span className="tag tag-off" style={{ marginLeft: 8 }}>Past the deadline</span>}</>}
          </p>

          <div className="dash-card" style={{ marginBottom: 12 }}>
            <h2>Operators</h2>
            <div className="table-wrap">
              <table className="dash-table">
                <thead><tr><th>Operator</th><th>Status</th><th>Strikes</th></tr></thead>
                <tbody>
                  {data.operators.map((o) => (
                    <tr key={o.id}><td>{o.legalName}</td><td><span className={`tag ${STATUS_TONE[o.status]}`}>{STATUS_LABEL[o.status]}</span></td><td><StrikeFlag n={o.strikes90} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="dash-card" style={{ marginBottom: 12 }}>
            <h2>Weekday plan</h2>
            <div className="table-wrap">
              <table className="dash-table">
                <thead><tr><th>Product</th>{WEEKDAYS.map((w) => <th key={w}>{w}</th>)}</tr></thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.id}>
                      <td>#{p.catalogue_no} {p.title}</td>
                      {WEEKDAYS.map((_, wd) => (
                        <td key={wd}>
                          <select value={planOf(p.id, wd)} disabled={busy} aria-label={`${p.title}, ${WEEKDAYS[wd]}`}
                            onChange={(e) => run(() => call(`/admin/roster/${month}/plan`, "PUT", { productId: p.id, weekday: wd, operatorId: e.target.value ? Number(e.target.value) : null }))}>
                            <option value="">—</option>
                            {eligible(p.id).map((o) => <option key={o.id} value={o.id}>{o.legalName}</option>)}
                          </select>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cat-actions">
              <button className="btn-ghost" disabled={busy} onClick={() => run(() => call(`/admin/roster/${month}/build`, "POST", {}),
                (r) => `Built ${r.written} dates.${r.skipped?.length ? ` ${r.skipped.length} skipped (kept an override or swap, or the operator isn't eligible).` : ""}`)}>
                <RefreshCw size={14} />Build month from plan
              </button>
              <button className="btn-primary" disabled={busy} onClick={() => run(() => call(`/admin/roster/${month}/publish`, "POST", {}), "Roster published.")}>
                {data.state === "published" ? "Republish" : "Publish"}
              </button>
            </div>
          </div>

          <div className="dash-card" style={{ marginBottom: 12 }}>
            <h2>Dates</h2>
            {data.entries.length ? (
              <div className="table-wrap">
                <table className="dash-table">
                  <thead><tr><th>Date</th><th>Product</th><th>Operator</th><th>Source</th></tr></thead>
                  <tbody>
                    {data.entries.map((e) => {
                      const p = data.products.find((x) => x.id === e.productId);
                      return (
                        <tr key={e.id}>
                          <td>{dayLabel(e.date)}</td>
                          <td>{p ? `#${p.catalogue_no} ${p.title}` : e.productId}</td>
                          <td>
                            <select value={e.operatorId} disabled={busy}
                              onChange={(ev) => run(() => call("/admin/roster/entries", "PUT", { productId: e.productId, date: e.date, operatorId: ev.target.value ? Number(ev.target.value) : null }), "Date updated.")}>
                              <option value="">Remove</option>
                              {!eligible(e.productId).some((o) => o.id === e.operatorId) && <option value={e.operatorId}>{e.operatorName} (not eligible)</option>}
                              {eligible(e.productId).map((o) => <option key={o.id} value={o.id}>{o.legalName}</option>)}
                            </select>
                          </td>
                          <td>{e.source}{e.updatedBy && <div className="field-hint">{e.updatedBy}</div>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="field-hint">No dates yet. Plan the weekdays and build the month.</p>}
          </div>

          <div className="dash-card">
            <h2>Swap requests</h2>
            {data.swaps.length ? (
              <div className="table-wrap">
                <table className="dash-table">
                  <thead><tr><th>Date</th><th>From</th><th>To</th><th>Note</th><th>State</th><th></th></tr></thead>
                  <tbody>
                    {data.swaps.map((s) => (
                      <tr key={s.id}>
                        <td>{dayLabel(s.date)}</td>
                        <td>{opName.get(s.fromOperatorId)?.legalName || s.fromOperatorId}</td>
                        <td>{opName.get(s.toOperatorId)?.legalName || s.toOperatorId}</td>
                        <td>{s.note || "—"}</td>
                        <td>{s.state}{s.decidedBy && <div className="field-hint">by {s.decidedBy}, {stamp(s.decidedAt)}</div>}</td>
                        <td className="row-actions">
                          {s.state === "requested" && <>
                            <button className="btn-ghost sm" disabled={busy} onClick={() => run(() => call(`/admin/roster/swaps/${s.id}/decide`, "POST", { approve: true }), "Swap approved.")}><Check size={14} />Approve</button>
                            <button className="btn-ghost sm" disabled={busy} onClick={() => run(() => call(`/admin/roster/swaps/${s.id}/decide`, "POST", { approve: false }), "Swap rejected.")}><X size={14} />Reject</button>
                          </>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="field-hint">No swap requests this month.</p>}
          </div>
        </>
      )}
    </>
  );
}

// ============================================================ Rate card
export function RatesSection({ flash }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [migration, setMigration] = useState(null);
  const [editing, setEditing] = useState(null);

  async function load() {
    try { setErr(""); setData(await call("/admin/rates")); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function importFile(file) {
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const r = await call("/admin/rates/import", "POST", { dataUrl: await readFile(file), filename: file.name });
      setReport(r);
      flash(`Imported ${r.imported.length} products as drafts; ${r.skipped.length} rows skipped.`);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (editing) {
    return <RateEditor product={editing} flash={flash} onClose={() => { setEditing(null); load(); }} />;
  }

  return (
    <>
      <Head title="Rate card"
        sub="Per product, in EGP: the selling price and operator fee per tier, the cost lines, the collecting agent's commission and the published EUR rate. The operator is paid its entitlement; agencies share the pool. A departure keeps the version in force when its first seat sold."
        action={<label className="btn-ghost" style={{ cursor: "pointer" }}><Upload size={16} />Import spreadsheet
          <input type="file" accept=".xlsx" hidden disabled={busy} onChange={(e) => importFile(e.target.files?.[0])} /></label>} />
      {err && <div className="auth-error">{err}</div>}
      {/* Phase 5: what migration 061 converted from the phase 2 rate card. */}
      <div className="cat-actions" style={{ justifyContent: "flex-start", marginBottom: 8 }}>
        <button type="button" className="btn-ghost sm" onClick={() => call("/admin/rates/migration-report").then((j) => setMigration(j.lines)).catch((e) => setErr(e.message))}>What the conversion changed</button>
      </div>
      {migration && (
        <div className="dash-card" style={{ marginBottom: 12 }}>
          <h2>Converted to the pool model (migration 061)</h2>
          <ul>{migration.map((l, i) => <li key={i} style={{ whiteSpace: "pre-wrap" }}>{l}</li>)}</ul>
          <div className="cat-actions"><button className="btn-ghost" onClick={() => setMigration(null)}>Close</button></div>
        </div>
      )}
      {report && (
        <div className="dash-card" style={{ marginBottom: 12 }}>
          <h2>Import</h2>
          <p>{report.imported.length} imported as drafts, {report.skipped.length} skipped.</p>
          {report.notes.length > 0 && <><h3>Notes</h3><ul>{report.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
          {report.problems.length > 0 && <><h3>Check these</h3><ul>{report.problems.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
          {report.skipped.length > 0 && <><h3>Skipped</h3><ul>{report.skipped.map((s, i) => <li key={i}>{s.sheet} row {s.row}: {s.reason}</li>)}</ul></>}
          {report.imported.some((r) => r.blank.length) && <p className="field-hint">{report.imported.filter((r) => r.blank.length).length} drafts still have blank amounts; fill them in before publishing.</p>}
          <div className="cat-actions"><button className="btn-ghost" onClick={() => setReport(null)}>Close</button></div>
        </div>
      )}
      {data && (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>#</th><th>Product</th><th>Type</th><th>In force</th><th>Draft</th></tr></thead>
            <tbody>
              {data.products.map((p) => {
                const published = p.versions.filter((v) => v.state === "published");
                const latest = published[published.length - 1];
                const draft = p.versions.find((v) => v.state === "draft");
                return (
                  <tr key={p.id} className="cat-row-link" tabIndex={0} onClick={() => setEditing(p)} onKeyDown={(e) => { if (e.key === "Enter") setEditing(p); }}>
                    <td className="tnum">{p.catalogue_no}</td>
                    <td><strong>{p.title}</strong></td>
                    <td>{TYPE_LABELS[p.type] || p.type}</td>
                    <td>{latest ? `v${latest.version} from ${dayLabel(latest.effectiveFrom)}` : <span className="tag tag-warn">None</span>}</td>
                    <td>{draft ? `v${draft.version}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Phase 5 (28 Sep 2026): the pricing and money model (shared/pool-model.js).
// Tiers with an EGP selling price and an operator fee; cost lines per group
// or per traveler with an amount per tier; the collecting agent's commission; the
// published EUR rate. The table below it is the same calculation the
// statements use, live, for 2 to 12 travelers.
const blankTiers = () => DEFAULT_POOL_TIERS.map((t) => ({ ...t, priceEgp: "", operatorFeePct: t.operatorFeePct == null ? "" : String(t.operatorFeePct) }));
const toForm = (v) => ({
  tiers: (v?.tiers?.length ? v.tiers : null)?.map((t) => ({ from: String(t.from), to: String(t.to), priceEgp: t.priceEgp ?? "", operatorFeePct: t.operatorFeePct ?? "" })) || blankTiers(),
  costLines: (v?.costLines || []).map((l) => ({ name: l.name, basis: l.basis, amounts: (l.amounts || []).map((a) => a ?? "") })),
  commissionPct: v?.commissionPct ?? DEFAULT_COMMISSION_PCT,
  eurRate: v?.eurRate ?? "",
});
const numOrNull = (x) => (x === "" || x == null ? null : Number(x));
const fromForm = (f) => ({
  tiers: f.tiers.map((t) => ({ from: Number(t.from), to: Number(t.to), priceEgp: numOrNull(t.priceEgp), operatorFeePct: numOrNull(t.operatorFeePct) })),
  costLines: f.costLines.map((l) => ({ name: l.name, basis: l.basis, amounts: l.amounts.map(numOrNull) })),
  commissionPct: numOrNull(f.commissionPct),
  eurRate: numOrNull(f.eurRate),
});
const egpFmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

function RateEditor({ product, flash, onClose }) {
  const [versions, setVersions] = useState(product.versions);
  const draft = versions.find((v) => v.state === "draft");
  const [form, setForm] = useState(() => toForm(draft || versions[versions.length - 1]));
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const model = fromForm(form);
  const problem = poolRateError(model);
  const table = problem ? null : poolRateTable(model);

  async function reload() {
    const j = await call("/admin/rates");
    setVersions(j.products.find((p) => p.id === product.id)?.versions || []);
  }
  async function save(e) {
    e?.preventDefault();
    setBusy(true); setErr("");
    try {
      await call(`/admin/rates/${product.id}/draft`, "PUT", { values: model });
      flash("Draft saved."); await reload();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true); setErr("");
    try {
      const { version } = await call(`/admin/rates/${product.id}/draft`, "PUT", { values: model });
      await call(`/admin/rates/${product.id}/versions/${version.id}/publish`, "POST", { effectiveFrom: effectiveFrom || undefined });
      flash(`Version ${version.version} published.`); await reload();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  const setTier = (i, k, v) => setForm({ ...form, tiers: form.tiers.map((t, j) => (j === i ? { ...t, [k]: v } : t)) });
  const setLine = (i, patch) => setForm({ ...form, costLines: form.costLines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const addTier = () => {
    const last = form.tiers[form.tiers.length - 1];
    const from = last ? Number(last.to) + 1 : 4;
    setForm({ tiers: [...form.tiers, { from: String(from), to: String(from + 2), priceEgp: "", operatorFeePct: "" }], costLines: form.costLines.map((l) => ({ ...l, amounts: [...l.amounts, ""] })), commissionPct: form.commissionPct, eurRate: form.eurRate });
  };
  const removeTier = (i) => setForm({ ...form, tiers: form.tiers.filter((_, j) => j !== i), costLines: form.costLines.map((l) => ({ ...l, amounts: l.amounts.filter((_, j) => j !== i) })) });
  const addLine = () => setForm({ ...form, costLines: [...form.costLines, { name: "", basis: "per_group", amounts: form.tiers.map(() => "") }] });

  return (
    <>
      <Head title={`#${product.catalogue_no} ${product.title}`} sub={`${TYPE_LABELS[product.type] || product.type} · all amounts in EGP; travelers see and pay EUR at the published rate`}
        action={<button className="btn-ghost" onClick={onClose}><ArrowLeft size={16} />Rate card</button>} />
      {err && <div className="auth-error">{err}</div>}
      <form className="dash-card" style={{ marginBottom: 12 }} onSubmit={save}>
        <h2>{draft ? `Draft v${draft.version}` : "New draft"}</h2>
        <h3>Price</h3>
        <p className="field-hint" style={{ marginTop: 0 }}>One selling price per traveler for 4–8 travelers. The operator fee is required: it is set case by case for each product, and a rate card can't be published without it. Add a tier only if the price should change with the group size.</p>
        <div className="table-wrap"><table className="dash-table">
          <thead><tr><th>From</th><th>To</th><th>Selling price per traveler (EGP)</th><th>Operator fee (% of operating cost), required</th><th>Travelers see</th><th /></tr></thead>
          <tbody>{form.tiers.map((t, i) => (
            <tr key={i}>
              <td><input type="number" min="1" step="1" value={t.from} onChange={(e) => setTier(i, "from", e.target.value)} style={{ width: 70 }} /></td>
              <td><input type="number" min="1" step="1" value={t.to} onChange={(e) => setTier(i, "to", e.target.value)} style={{ width: 70 }} /></td>
              <td><input type="number" min="0" step="0.01" value={t.priceEgp} onChange={(e) => setTier(i, "priceEgp", e.target.value)} /></td>
              <td><input type="number" min="0" max="100" step="0.1" value={t.operatorFeePct} onChange={(e) => setTier(i, "operatorFeePct", e.target.value)} style={{ width: 90 }} /></td>
              <td className="tnum">{tierPriceEur(numOrNull(t.priceEgp), numOrNull(form.eurRate)) == null ? "—" : `€${tierPriceEur(numOrNull(t.priceEgp), numOrNull(form.eurRate))}`}</td>
              <td>{form.tiers.length > 1 && <button type="button" className="btn-mini" onClick={() => removeTier(i)}>Remove</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="cat-actions" style={{ justifyContent: "flex-start" }}><button type="button" className="btn-ghost sm" onClick={addTier}>Add a tier (optional)</button></div>
        <h3>Cost lines</h3>
        <div className="table-wrap"><table className="dash-table">
          <thead><tr><th>Name</th><th>Basis</th>{form.tiers.map((t, i) => <th key={i}>{t.from}–{t.to} (EGP)</th>)}<th /></tr></thead>
          <tbody>{form.costLines.map((l, i) => (
            <tr key={i}>
              <td><input value={l.name} maxLength={80} placeholder="e.g. Transport" onChange={(e) => setLine(i, { name: e.target.value })} /></td>
              <td><select value={l.basis} onChange={(e) => setLine(i, { basis: e.target.value })}>
                {COST_BASES.map((b) => <option key={b} value={b}>{COST_BASIS_LABELS[b]}</option>)}
              </select></td>
              {form.tiers.map((_, j) => (
                <td key={j}><input type="number" min="0" step="0.01" value={l.amounts[j] ?? ""} onChange={(e) => setLine(i, { amounts: l.amounts.map((a, k) => (k === j ? e.target.value : a)) })} style={{ width: 100 }} /></td>
              ))}
              <td><button type="button" className="btn-mini" onClick={() => setForm({ ...form, costLines: form.costLines.filter((_, j) => j !== i) })}>Remove</button></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="cat-actions" style={{ justifyContent: "flex-start" }}><button type="button" className="btn-ghost sm" onClick={addLine}>Add a cost line</button></div>
        <div className="form-grid">
          <label className="field"><span>Collecting agent's commission (% of the selling price)</span>
            <input type="number" min="0" max="99.99" step="0.1" value={form.commissionPct} onChange={(e) => setForm({ ...form, commissionPct: e.target.value })} /></label>
          <label className="field"><span>Published EUR rate (EGP per EUR)</span>
            <input type="number" min="0" step="0.0001" value={form.eurRate} onChange={(e) => setForm({ ...form, eurRate: e.target.value })} /></label>
          <label className="field"><span>Takes effect</span><input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
        </div>
        <p className="field-hint">The published EUR rate is used only to show and charge travelers in EUR (each tier price ÷ the rate, rounded up to a whole euro). Everything below, and every statement, is in EGP. A published version applies to departures that haven't sold a seat yet; departures already sold keep the version they were locked to.</p>
        {tierPriceLine(model.tiers, model.eurRate) && <p className="field-hint">Tour page: {tierPriceLine(model.tiers, model.eurRate)}</p>}
        {problem && <div className="auth-error">{problem}</div>}

        <h3>By group size</h3>
        {table ? (
          <>
            {table.warnings.length > 0 && <ul>{table.warnings.map((w, i) => <li key={i}><span className="tag tag-warn">{w.kind === "negative_pool" ? "Guarantee needed" : "Pool shrinks"}</span> {w.text}</li>)}</ul>}
            <div className="table-wrap"><table className="dash-table">
              <thead><tr><th>Travelers</th><th>Tier</th><th>Revenue</th><th>Operating cost</th><th>Operator fee</th><th>Entitlement</th><th>Agent</th><th>Pool</th><th>Pool / traveler</th><th>vs one fewer</th></tr></thead>
              <tbody>{table.rows.map((r) => (
                <tr key={r.headcount} className={r.negativePool || r.poolShrinks ? "row-warn" : ""}>
                  <td className="tnum">{r.headcount}</td>
                  {r.complete ? (<>
                    <td>{r.tier}</td><td className="tnum">{egpFmt(r.revenue)}</td><td className="tnum">{egpFmt(r.operatingCost)}</td>
                    <td className="tnum">{egpFmt(r.operatorFee)}</td><td className="tnum">{egpFmt(r.entitlement)}</td><td className="tnum">{egpFmt(r.commission)}</td>
                    <td className="tnum">{r.negativePool ? <b>{egpFmt(r.pool)}</b> : egpFmt(r.pool)}</td><td className="tnum">{egpFmt(r.poolPerTraveller)}</td>
                    <td className="tnum">{r.poolChange == null ? "—" : `${r.poolChange > 0 ? "+" : ""}${egpFmt(r.poolChange)}`}</td>
                  </>) : <td colSpan={9} className="field-hint">Missing: {r.missing.slice(0, 4).join(", ")}{r.missing.length > 4 ? "…" : ""}</td>}
                </tr>
              ))}</tbody>
            </table></div>
          </>
        ) : <p className="field-hint">Fix the rate card above to see the table.</p>}
        <div className="cat-actions">
          <button className="btn-ghost" disabled={busy || !!problem}>Save draft</button>
          <button type="button" className="btn-primary" disabled={busy || !!problem} onClick={publish}>Publish</button>
        </div>
      </form>
      <div className="dash-card">
        <h2>Versions</h2>
        {versions.length ? (
          <div className="table-wrap">
            <table className="dash-table">
              <thead><tr><th>Version</th><th>State</th><th>From</th><th>Prices (EGP)</th><th>Operator fee</th><th>Cost lines</th><th>Commission</th><th>EUR rate</th></tr></thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>v{v.version}</td><td>{v.state}{v.publishedBy && <div className="field-hint">{v.publishedBy}</div>}</td>
                    <td>{v.effectiveFrom ? dayLabel(v.effectiveFrom) : "—"}</td>
                    <td className="tnum">{(v.tiers || []).map((t) => egpFmt(t.priceEgp)).join(" / ")}</td>
                    <td className="tnum">{(v.tiers || []).map((t) => (t.operatorFeePct == null ? "—" : `${t.operatorFeePct}%`)).join(" / ")}</td>
                    <td>{(v.costLines || []).map((l) => `${l.name} (${COST_BASIS_LABELS[l.basis] || l.basis})`).join(", ") || "—"}
                      {v.source?.migration061 && <div className="field-hint">Converted by migration 061: {(v.source.migration061.notes || []).join("; ")}</div>}</td>
                    <td className="tnum">{v.commissionPct}%</td>
                    <td className="tnum">{v.eurRate ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="field-hint">No versions yet.</p>}
      </div>
    </>
  );
}

// ============================================================ Calendar panel
// The operator side of one calendar departure: who holds it, reassign,
// manifest and expected amount.
// The operator fee for this departure alone: a percentage and a reason, logged
// with who changed it. Editable until the operator acknowledges the offer, then locked.
function OperatorFeeForm({ departure, expected, locked, flash, onChange }) {
  const override = departure.operatorFeeOverride;
  const [pct, setPct] = useState(override ? String(override.pct) : "");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPct(override ? String(override.pct) : ""); setReason(""); setErr(""); }, [departure.id, override?.pct]);

  async function save(next) {
    setBusy(true); setErr("");
    try {
      await call(`/admin/catalogue/departures/${departure.id}/operator-fee`, "POST", { pct: next, reason });
      flash(next == null ? "Back to the rate card's operator fee." : "Operator fee saved for this departure.");
      setReason("");
      onChange();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="op-fee" style={{ margin: "12px 0" }}>
      <strong>Operator fee for this departure</strong>
      <p className="field-hint" style={{ margin: "4px 0" }}>
        {expected?.operatorFeePct != null ? `Applies now: ${expected.operatorFeePct}% of operating cost${expected.feeOverride ? " (set for this departure)" : " (from the rate card)"}.` : "The rate card's fee applies."}
        {override && <> Set by {override.by} on {String(override.at).slice(0, 10)}: “{override.reason}”.</>}
      </p>
      {locked ? (
        <p className="field-hint">The operator has acknowledged the offer, so the fee is locked for this departure.</p>
      ) : (
        <form className="cat-actions" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); save(pct === "" ? null : Number(pct)); }}>
          <input type="number" min="0" max="100" step="0.1" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="% of operating cost" aria-label="Operator fee percentage" style={{ width: 150 }} />
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" aria-label="Reason" required style={{ minWidth: 220 }} />
          <button className="btn-ghost sm" disabled={busy}>{pct === "" ? "Use the rate card's fee" : "Save fee"}</button>
        </form>
      )}
      {err && <div className="auth-error">{err}</div>}
    </div>
  );
}

export function DepartureOperatorPanel({ departure, operators, flash, onChange, onClose }) {
  const [manifest, setManifest] = useState(null);
  const [expected, setExpected] = useState(null);
  const [operatorId, setOperatorId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const a = departure.assignment;

  useEffect(() => {
    setErr("");
    call(`/admin/catalogue/departures/${departure.id}/expected`).then(setExpected).catch((e) => setErr(e.message));
    call(`/admin/catalogue/departures/${departure.id}/manifest`).then(setManifest).catch(() => setManifest(null));
  }, [departure.id]);

  // Phase 3: when the current operator's advance has been paid, say why the
  // departure moves (the server asks; the choice decides what it repays).
  const [why, setWhy] = useState(null);
  const [costLines, setCostLines] = useState([]);
  const [penalties, setPenalties] = useState([]);
  async function assign(e) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const body = { operatorId: Number(operatorId) };
      if (why?.reason) {
        Object.assign(body, { reason: why.reason, note: why.note || undefined });
        if (why.reason === "operator_fault" && why.penaltyCode) Object.assign(body, { penaltyCode: why.penaltyCode, travelers: Number(why.travelers) || null });
        if (why.reason === "not_operator_fault") Object.assign(body, { keptEgp: Number(why.keptEgp) || 0, costLineIds: why.costLineIds || [] });
      }
      const r = await apiFetch(`/admin/catalogue/departures/${departure.id}/assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.code === "reason_required") {
        const s = await call(`/admin/catalogue/departures/${departure.id}/settlement`).catch(() => null);
        setCostLines(s?.costLines || []);
        setPenalties(s?.penalties || []);
        setWhy({ reason: "" });
        throw new Error(j.error);
      }
      if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
      setWhy(null);
      flash(`Assigned. The operator has ${ACK_HOURS} hours to acknowledge.`);
      onChange();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="dash-card" style={{ marginBottom: 12 }}>
      <div className="dash-card-head">
        <h2>{departure.code} {departure.title}, {dayLabel(departure.date)}</h2>
        <button className="btn-ghost sm" onClick={onClose}><X size={14} />Close</button>
      </div>
      {err && <div className="auth-error">{err}</div>}
      <p>
        Rostered: {departure.rostered ? `${departure.rostered.name}${departure.rostered.published ? "" : " (roster not published)"}` : "nobody"}.{" "}
        {a ? <>Assigned to <b>{a.name}</b>: {ASSIGN_LABEL[a.state]}{a.state === "offered" && <> (due {stamp(a.ackDueAt)})</>}.</> : "Not assigned."}
      </p>
      <OperatorFeeForm departure={departure} expected={expected} locked={a?.state === "acknowledged"} flash={flash} onChange={onChange} />
      {departure.status === "go_ahead" && (
        <form onSubmit={assign} className="cat-actions">
          <select value={operatorId} onChange={(e) => setOperatorId(e.target.value)} required aria-label="Operator">
            <option value="">Choose an operator</option>
            {(operators || []).map((o) => <option key={o.id} value={o.id}>{o.legalName}</option>)}
          </select>
          <button className="btn-primary" disabled={busy || !operatorId || (why && !why.reason)}>{a ? "Reassign" : "Assign"}</button>
        </form>
      )}
      {why && (
        <div className="dash-card" style={{ margin: "8px 0" }}>
          <h3>Why is {a?.name} losing this departure? Its advance was paid.</h3>
          <label className="field-check"><input type="radio" name="why" checked={why.reason === "operator_fault"} onChange={() => setWhy({ ...why, reason: "operator_fault" })} />
            {" "}The operator's fault (it canceled, or didn't acknowledge): it repays the whole advance, set off against its next payments.</label>
          <label className="field-check"><input type="radio" name="why" checked={why.reason === "not_operator_fault"} onChange={() => setWhy({ ...why, reason: "not_operator_fault" })} />
            {" "}Not the operator's fault (Sawa, or force majeure): it keeps its evidenced non-refundable costs and repays the rest.</label>
          {why.reason === "operator_fault" && (
            <div className="form-grid">
              <label className="field"><span>Schedule 6 penalty (optional)</span>
                <select value={why.penaltyCode || ""} onChange={(e) => setWhy({ ...why, penaltyCode: e.target.value })}>
                  <option value="">None</option>{penalties.map((p) => <option key={p.code} value={p.code}>{p.label}: EGP {p.amountEgp}{p.perTraveler ? " per traveler" : ""}</option>)}
                </select>
              </label>
              {penalties.find((p) => p.code === why.penaltyCode)?.perTraveler && (
                <label className="field"><span>Travelers</span><input type="number" min="1" max="12" value={why.travelers || ""} onChange={(e) => setWhy({ ...why, travelers: e.target.value })} /></label>
              )}
            </div>
          )}
          {why.reason === "not_operator_fault" && (
            <div className="form-grid">
              <label className="field"><span>Costs the operator keeps (EGP)</span><input type="number" min="0" step="0.01" value={why.keptEgp || ""} onChange={(e) => setWhy({ ...why, keptEgp: e.target.value })} /></label>
              <div className="field field-full"><span>Evidence: approved cost-sheet lines</span>
                {costLines.length ? costLines.map((c) => (
                  <label key={c.id} className="field-check"><input type="checkbox" checked={(why.costLineIds || []).includes(c.id)}
                    onChange={(e) => setWhy({ ...why, costLineIds: e.target.checked ? [...(why.costLineIds || []), c.id] : (why.costLineIds || []).filter((x) => x !== c.id) })} />
                    {" "}#{c.id} {c.description} (EUR {c.amount})</label>
                )) : <p className="field-hint">No approved lines on this departure's cost sheet. Add them in Settlements first, or keep nothing.</p>}
              </div>
            </div>
          )}
          <label className="field field-full"><span>Note</span><input value={why.note || ""} onChange={(e) => setWhy({ ...why, note: e.target.value })} /></label>
        </div>
      )}
      {expected && (
        <>
          <h3>Expected operator amount {expected.frozen ? "(manifest frozen)" : "(live)"}</h3>
          <p className="field-hint">Rate version {expected.rateVersion ?? "none"} · {expected.travelers} travelers{expected.band ? ` · band ${expected.band.replace("-", "–")}` : ""}. Reference only; nothing is paid from here.</p>
          {expected.lines.length > 0 && (
            <table className="dash-table">
              <tbody>
                {expected.lines.map((l, i) => <tr key={i}><td>{l.label}</td><td className="tnum">{l.qty} × {egp(l.unit)}</td><td className="tnum">{egp(l.amount)}</td></tr>)}
                <tr><td><b>Total</b></td><td></td><td className="tnum"><b>{expected.total == null ? `Missing: ${expected.missing.join(", ")}` : egp(expected.total)}</b></td></tr>
              </tbody>
            </table>
          )}
          {!expected.lines.length && <p className="field-hint">Missing: {expected.missing.join(", ")}</p>}
        </>
      )}
      {manifest && (
        <>
          <h3>Manifest {manifest.frozen ? `(frozen ${stamp(manifest.frozenAt)})` : "(live until the cut-off)"}</h3>
          <ManifestTable travelers={manifest.travelers} />
        </>
      )}
      {(departure.status === "go_ahead" || departure.status === "completed") && <SettlementBlock departureId={departure.id} flash={flash} />}
    </div>
  );
}

// ============================================================ Settlement (phase 3)
const PAYABLE_LABEL = { advance: "Advance (50%)", balance: "Balance" };
const ADJ_LABEL = { penalty: "Penalty", service_failure: "Service-failure deduction", reimbursement: "Force-majeure reimbursement" };
const COST_LINE_CATEGORIES = [
  ["transport", "Transportation"], ["guide", "Tour guide"], ["entrance", "Entrance fees"], ["meals", "Meals"],
  ["activities", "Activities"], ["accommodation", "Accommodation"], ["permits", "Permits"], ["local_services", "Local services"], ["other", "Other"],
];

function SettlementBlock({ departureId, flash }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [adj, setAdj] = useState(null);
  const [cost, setCost] = useState(null);
  const [note, setNote] = useState("");
  async function load() {
    try { setErr(""); setD(await call(`/admin/catalogue/departures/${departureId}/settlement`)); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [departureId]);
  const run = async (fn, msg) => {
    setBusy(true); setErr("");
    try { await fn(); flash(msg); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  async function upload(file) {
    const dataUrl = await readFile(file);
    const r = await apiFetch("/cost-receipts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, dataUrl }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Upload failed.");
    return j.ref;
  }
  if (!d) return err ? <div className="auth-error">{err}</div> : null;
  const st = d.statement;
  const editable = !st || st.state === "draft" || st.state === "disputed";
  return (
    <>
      <h3>Settlement (EGP)</h3>
      {err && <div className="auth-error">{err}</div>}
      <p className="field-hint">Operator amount {egp(d.expected.total)} · advance {egp(d.advance)} · deductions {egp(d.deductionsApplied)}{d.capped ? " (capped)" : ""} · reimbursements {egp(d.reimbursements)} · balance <b>{egp(d.balance)}</b></p>
      {d.payables.length > 0 && (
        <table className="dash-table"><tbody>{d.payables.map((p) => (
          <tr key={p.id}><td>{PAYABLE_LABEL[p.kind]}</td><td className="tnum">{egp(p.amount)}{p.setoffEgp > 0 && <div className="field-hint">less {egp(p.setoffEgp)} set off: {egp(p.netDue)} to transfer</div>}</td><td>due {dayLabel(p.dueOn)}</td>
            <td>{p.state}{p.holdReason && <div className="field-hint">{p.holdReason}</div>}</td></tr>
        ))}</tbody></table>
      )}
      {d.receivables?.length > 0 && (
        <>
          <h4>Owed to Sawa (set off against the operator's next payments)</h4>
          <table className="dash-table"><tbody>{d.receivables.map((r) => (
            <tr key={r.id}><td>{r.reason}<div className="field-hint">{r.clauseRef}</div></td><td className="tnum">{egp(r.amountEgp)}</td>
              <td>{r.state === "settled" ? "recovered" : `outstanding ${egp(r.outstandingEgp)}`}</td></tr>
          ))}</tbody></table>
        </>
      )}
      <h4>Adjustments</h4>
      {d.adjustments.length ? (
        <table className="dash-table"><tbody>{d.adjustments.map((a) => (
          <tr key={a.id}><td>{ADJ_LABEL[a.kind]}</td><td className="tnum">{a.kind === "reimbursement" ? "+" : "−"}{egp(a.amountEgp)}</td>
            <td>{a.reason}<div className="field-hint">{a.clauseRef}{a.evidence.length ? ` · ${a.evidence.length} evidence file${a.evidence.length === 1 ? "" : "s"}` : ""}{a.costLineIds.length ? ` · cost lines ${a.costLineIds.join(", ")}` : ""}</div></td>
            <td className="row-actions">{editable && <button className="btn-ghost sm" disabled={busy} onClick={() => { const reason = window.prompt("Why void this adjustment?"); if (reason) run(() => call(`/admin/operator-adjustments/${a.id}/void`, "POST", { reason }), "Adjustment voided."); }}>Void</button>}</td></tr>
        ))}</tbody></table>
      ) : <p className="field-hint">None.</p>}
      {editable && d.operator && (adj ? (
        <form onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const evidence = [];
            for (const f of adj.files || []) evidence.push(await upload(f));
            await call(`/admin/catalogue/departures/${departureId}/adjustments`, "POST", {
              kind: adj.kind, reason: adj.reason, clauseRef: adj.clauseRef || undefined, evidence,
              ...(adj.kind === "penalty" ? { penaltyCode: adj.penaltyCode, travelers: Number(adj.travelers) || null } : { amountEgp: Number(adj.amountEgp) }),
              ...(adj.kind === "reimbursement" ? { costLineIds: adj.costLineIds } : {}),
            });
            setAdj(null);
          }, "Adjustment recorded.");
        }}>
          <div className="form-grid">
            <label className="field"><span>Type</span>
              <select value={adj.kind} onChange={(e) => setAdj({ ...adj, kind: e.target.value })}>
                {Object.entries(ADJ_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            {adj.kind === "penalty" ? (
              <>
                <label className="field"><span>Penalty (Schedule 6)</span>
                  <select value={adj.penaltyCode || ""} onChange={(e) => setAdj({ ...adj, penaltyCode: e.target.value })} required>
                    <option value="">Choose</option>
                    {d.penalties.map((p) => <option key={p.code} value={p.code}>{p.label}: EGP {p.amountEgp}{p.perTraveler ? " per traveler" : ""}</option>)}
                  </select>
                </label>
                {d.penalties.find((p) => p.code === adj.penaltyCode)?.perTraveler && (
                  <label className="field"><span>Travelers</span><input type="number" min="1" max="12" value={adj.travelers || ""} onChange={(e) => setAdj({ ...adj, travelers: e.target.value })} required /></label>
                )}
              </>
            ) : (
              <label className="field"><span>Amount (EGP)</span><input type="number" min="0" step="0.01" value={adj.amountEgp || ""} onChange={(e) => setAdj({ ...adj, amountEgp: e.target.value })} required /></label>
            )}
            <label className="field"><span>Clause</span><input value={adj.clauseRef || ""} onChange={(e) => setAdj({ ...adj, clauseRef: e.target.value })} placeholder={adj.kind === "service_failure" ? "Operator clause 12.2" : adj.kind === "reimbursement" ? "Operator clause 14" : "from Schedule 6"} required={adj.kind !== "penalty"} /></label>
            <label className="field field-full"><span>Reason</span><textarea rows={2} value={adj.reason || ""} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} required minLength={3} /></label>
            {adj.kind === "reimbursement" ? (
              <div className="field field-full"><span>Approved cost-sheet lines (receipts attached there)</span>
                {d.costLines.length ? d.costLines.map((c) => (
                  <label key={c.id} className="field-check"><input type="checkbox" checked={(adj.costLineIds || []).includes(c.id)}
                    onChange={(e) => setAdj({ ...adj, costLineIds: e.target.checked ? [...(adj.costLineIds || []), c.id] : (adj.costLineIds || []).filter((x) => x !== c.id) })} />
                    {" "}#{c.id} {c.description} (EUR {c.amount}){c.hasReceipt ? "" : ", no receipt"}</label>
                )) : <p className="field-hint">No approved lines on this departure's cost sheet yet. Add them under "Cost sheet" below first.</p>}
              </div>
            ) : (
              <label className="field field-full"><span>Evidence files</span><input type="file" multiple accept="application/pdf,image/*" onChange={(e) => setAdj({ ...adj, files: [...(e.target.files || [])] })} /></label>
            )}
          </div>
          <div className="cat-actions">
            <button type="button" className="btn-ghost" onClick={() => setAdj(null)}>Cancel</button>
            <button className="btn-primary" disabled={busy}>Record</button>
          </div>
        </form>
      ) : <button className="btn-ghost sm" onClick={() => setAdj({ kind: "service_failure" })}>Add adjustment</button>)}
      {/* The cost sheet, with receipts: what a force-majeure reimbursement
          points at. It feeds this settlement only; catalog departures never
          appear in the old Settlements module. Lines Sawa adds are approved. */}
      <h4>Cost sheet</h4>
      {d.costLines.length ? (
        <table className="dash-table"><tbody>{d.costLines.map((c) => (
          <tr key={c.id}><td>#{c.id} {c.description}<div className="field-hint">{c.category}{c.hasReceipt ? "" : " · no receipt"}</div></td><td className="tnum">EUR {c.amount}</td></tr>
        ))}</tbody></table>
      ) : <p className="field-hint">No lines.</p>}
      {d.legacyDepartureId != null && (cost ? (
        <form onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const receiptUrl = cost.file ? await upload(cost.file) : undefined;
            await call(`/admin/settlements/${d.legacyDepartureId}/costs`, "POST", {
              category: cost.category, description: cost.description, basis: "group", amount: Number(cost.amount), receiptUrl,
            });
            setCost(null);
          }, "Cost line added.");
        }}>
          <div className="form-grid">
            <label className="field"><span>Category</span>
              <select value={cost.category} onChange={(e) => setCost({ ...cost, category: e.target.value })}>
                {COST_LINE_CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="field"><span>Amount (EUR)</span><input type="number" min="0.01" step="0.01" value={cost.amount || ""} onChange={(e) => setCost({ ...cost, amount: e.target.value })} required /></label>
            <label className="field field-full"><span>Description</span><input value={cost.description || ""} onChange={(e) => setCost({ ...cost, description: e.target.value })} required maxLength={300} /></label>
            <label className="field field-full"><span>Receipt</span><input type="file" accept="application/pdf,image/*" onChange={(e) => setCost({ ...cost, file: e.target.files?.[0] || null })} /></label>
          </div>
          <div className="cat-actions">
            <button type="button" className="btn-ghost" onClick={() => setCost(null)}>Cancel</button>
            <button className="btn-primary" disabled={busy}>Add line</button>
          </div>
        </form>
      ) : <button className="btn-ghost sm" onClick={() => setCost({ category: "transport" })}>Add cost line</button>)}
      <h4>Statement</h4>
      {st ? (
        <>
          <p>
            <span className="tag">{st.state}</span>
            {st.sentAt && <> sent {stamp(st.sentAt)}{st.autoAcceptOn && <> · accepted automatically on {stamp(st.autoAcceptOn)} unless disputed</>}</>}
            {st.autoAccepted && <> · accepted automatically</>}
          </p>
          {st.disputeReason && <p className="field-hint">Disputed by {st.disputedBy}: {st.disputeReason}</p>}
          {st.resolutionNote && <p className="field-hint">Resolved by {st.resolvedBy}: {st.resolutionNote}</p>}
          {/* The distribution of the departure's collections (27 Sep 2026). */}
          {st.snapshot?.distribution && (
            <table className="dash-table"><tbody>
              {/* Phase 5: EGP lines of the pool calculation; before it, EUR. */}
              {(st.snapshot.distribution.lines || []).map((l) => (
                <tr key={l.key}><td>{["agent_commission", "minimum_departure_guarantee", "operator_entitlement"].includes(l.key) ? <b>{l.label}</b> : l.label}</td>
                  <td className="tnum">{st.snapshot.distribution.model === "pool" ? "EGP" : "EUR"} {Number(l.amountEgp ?? l.amountEur).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>
              ))}
              {st.snapshot.distribution.ownAgencyShare && <tr><td colSpan={2} className="field-hint">{st.snapshot.distribution.ownAgencyShare.note}</td></tr>}
              {st.snapshot.distribution.problem && <tr><td colSpan={2}><span className="tag tag-warn">{st.snapshot.distribution.problem}</span></td></tr>}
            </tbody></table>
          )}
          <div className="cat-actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn-ghost sm" onClick={() => apiFetch(`/admin/catalogue/departures/${departureId}/statement.pdf`).then((r) => r.blob()).then((b) => window.open(URL.createObjectURL(b), "_blank", "noopener"))}>PDF</button>
            {st.state === "draft" && <button className="btn-primary sm" disabled={busy} onClick={() => run(() => call(`/admin/catalogue/departures/${departureId}/statement/send`, "POST", {}), "Statement sent to the operator.")}>Send to operator</button>}
          </div>
          {st.state === "disputed" && (
            <form onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/catalogue/departures/${departureId}/statement/resolve`, "POST", { note }).then(() => setNote("")), "Dispute resolved."); }}>
              <label className="field field-full"><span>Resolution note</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} required minLength={5} /></label>
              <div className="cat-actions"><button className="btn-primary sm" disabled={busy}>Resolve dispute</button></div>
            </form>
          )}
        </>
      ) : <p className="field-hint">Created with the balance once the departure has completed.</p>}
    </>
  );
}

// ============================================================ Bank details (phase 3)
function BankCard({ operatorId, legalName, flash }) {
  const [accounts, setAccounts] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    try { setErr(""); setAccounts((await call(`/admin/operators/${operatorId}/bank`)).accounts); } catch (e) { setErr(e.message); }
  }
  const run = async (fn, msg) => { setBusy(true); setErr(""); try { await fn(); flash(msg); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <div className="dash-card" style={{ marginBottom: 12 }}>
      <h2>Bank details</h2>
      <p className="field-hint">A change is used only after an admin verifies it; payments to this operator are held until then. The holder must be {legalName}. Every view and change is logged.</p>
      {err && <div className="auth-error">{err}</div>}
      {accounts == null ? <button className="btn-ghost sm" onClick={load}>Show bank details (logged)</button> : (
        <>
          {accounts.length ? (
            <table className="dash-table"><tbody>{accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.holderName}<div className="field-hint">{a.bankName}</div></td>
                <td>{a.iban || a.accountNumber}{a.swift && <div className="field-hint">SWIFT {a.swift}</div>}</td>
                <td><span className={`tag ${a.state === "verified" ? "tag-on" : a.state === "pending" ? "tag-warn" : "tag-off"}`}>{a.state}</span>
                  <div className="field-hint">by {a.submittedBy} {stamp(a.submittedAt)}{a.decidedBy ? ` · ${a.state} by ${a.decidedBy}` : ""}{a.decisionNote ? `: ${a.decisionNote}` : ""}</div></td>
                <td className="row-actions">{a.state === "pending" && <>
                  <button className="btn-primary sm" disabled={busy} onClick={() => run(() => call(`/admin/operator-bank/${a.id}/decide`, "POST", { approve: true }), "Bank details verified.")}>Verify</button>
                  <button className="btn-ghost sm" disabled={busy} onClick={() => { const n = window.prompt("Why are these details rejected?"); if (n) run(() => call(`/admin/operator-bank/${a.id}/decide`, "POST", { approve: false, note: n }), "Rejected."); }}>Reject</button>
                </>}</td>
              </tr>
            ))}</tbody></table>
          ) : <p className="field-hint">No bank details yet.</p>}
          {form ? (
            <form onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/operators/${operatorId}/bank`, "POST", form).then(() => setForm(null)), "Saved as pending verification. The operator and admin were emailed."); }}>
              <div className="form-grid">
                <label className="field"><span>Account holder</span><input value={form.holderName} onChange={(e) => setForm({ ...form, holderName: e.target.value })} required /></label>
                <label className="field"><span>Bank</span><input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} required /></label>
                <label className="field"><span>Account number</span><input value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} /></label>
                <label className="field"><span>IBAN</span><input value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} /></label>
                <label className="field"><span>SWIFT (if relevant)</span><input value={form.swift} onChange={(e) => setForm({ ...form, swift: e.target.value })} /></label>
              </div>
              <div className="cat-actions"><button type="button" className="btn-ghost" onClick={() => setForm(null)}>Cancel</button><button className="btn-primary" disabled={busy}>Save for verification</button></div>
            </form>
          ) : <button className="btn-ghost sm" onClick={() => setForm({ holderName: legalName, bankName: "", accountNumber: "", iban: "", swift: "" })}>Change bank details</button>}
        </>
      )}
    </div>
  );
}

export function ManifestTable({ travelers }) {
  if (!travelers?.length) return <p className="field-hint">No travelers yet.</p>;
  const nationality = travelers.some((t) => t.nationality !== undefined);
  const incomplete = travelers.filter((t) => t.missing?.length).length;
  // Model phase 4, before the cut-off: which seats are paid and which still
  // have payment due (an unpaid seat is released at its deadline).
  const unpaid = travelers.filter((t) => t.payment?.standing === "due").length;
  const payDue = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return (
    <div className="table-wrap">
      {incomplete > 0 && <p className="field-hint"><span className="tag tag-warn">Missing</span> {incomplete} row{incomplete === 1 ? "" : "s"} still lack details. Sawa asks travelers to complete them 7 days before the tour, with a reminder at 3.</p>}
      {unpaid > 0 && <p className="field-hint"><span className="tag tag-warn">Payment due</span> {unpaid} seat{unpaid === 1 ? " is" : "s are"} booked but not paid yet. A seat not paid by its deadline is released before the cut-off and comes off this manifest; you aren't paid for it (clause 10.1).</p>}
      <table className="dash-table">
        <thead><tr><th>Booking</th><th>Name</th><th>Pickup</th><th>Contact</th>{nationality && <th>Nationality</th>}<th>Safety needs</th></tr></thead>
        <tbody>
          {travelers.map((t, i) => {
            const miss = new Set(t.missing || []);
            const Missing = () => <span className="tag tag-warn">Missing</span>;
            return (
              <tr key={i} style={t.canceledAfterCutoff ? { opacity: 0.6 } : undefined}>
                <td>{t.booking}{t.party && (t.lead
                  ? <div><span className="tag">Group lead · {t.party.size} travelers</span></div>
                  : t.party.leadBooking !== t.booking && <div className="field-hint">with {t.party.lead || t.party.leadBooking}'s group</div>)}</td>
                <td>{t.name}{miss.has("name") && <> <Missing /></>}{t.canceledAfterCutoff && <div className="field-hint">canceled after the cut-off</div>}
                  {t.payment?.standing === "paid" && <div><span className="tag tag-on">Paid</span></div>}
                  {t.payment?.standing === "due" && <div><span className="tag tag-warn">{t.payment.dueAt ? `Payment due by ${payDue(t.payment.dueAt)}` : "Payment due"}</span></div>}</td>
                <td>{miss.has("pickupPoint") ? <Missing /> : t.pickupPoint || "—"}</td>
                <td>{miss.has("phone") && (!t.party || t.lead) ? <Missing /> : t.contactNumber || (t.lead ? "—" : t.party && t.party.leadBooking !== t.booking ? "via group lead" : "")}</td>
                {nationality && <td>{miss.has("nationality") ? <Missing /> : t.nationality || "—"}</td>}
                <td>{miss.has("safetyNeeds") ? <Missing /> : t.safetyNeeds || (t.lead ? "—" : "")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
