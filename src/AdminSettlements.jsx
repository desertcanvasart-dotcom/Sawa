// Admin → Settlements: tour costs, the profit split and the Wednesday payouts
// (044). Sawa approves every cost line, signs off each cost sheet, records its
// decisions (who absorbs a loss, who covers a non-refundable cost) and builds,
// approves and pays each Wednesday's run. The arithmetic is server-side
// (server/settlement.js); this screen shows it and records decisions.
import React, { useEffect, useState } from "react";
import { Check, X, ChevronDown, Plus, ExternalLink, Lock, Unlock, Paperclip, FileText, Eye, EyeOff, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { apiFetch, uploadReceipt, openReceipt, receiptLink } from "./supabaseClient";
import { fmtDate } from "./dates.js";
import { CURRENCY_SYMBOL } from "../shared/currency.js";

const money = (n) => (n == null ? "—" : `${Number(n) < 0 ? "−" : ""}${CURRENCY_SYMBOL}${Math.abs(Number(n)).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const pct = (p) => `${Math.round(p * 1000) / 10}%`;

async function send(path, body, method = "POST") {
  const r = await apiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

export function SettlementsSection({ flash }) {
  const [tab, setTab] = useState("departures");
  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Settlements</h1>
          <p>Revenue collected + extra income − approved costs = gross profit. Sawa takes 10%; the rest is shared by headcount. Paid every Wednesday for tours ended by the Saturday before.</p>
        </div>
      </div>
      <div className="seg pay-tabs" role="tablist" aria-label="Settlements">
        <button role="tab" aria-selected={tab === "departures"} className={tab === "departures" ? "active" : ""} onClick={() => setTab("departures")}>Departures</button>
        <button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>Wednesday payouts</button>
      </div>
      {tab === "departures" ? <DeparturesTab flash={flash} /> : <RunsTab flash={flash} />}
    </>
  );
}

function NotOn({ migration }) {
  return (
    <div className="dash-card pay-off">
      <strong>Settlements aren't switched on yet.</strong>
      <p>The settlement tables (migration {migration}) haven't been added to the database. Run this once against production, then reload:</p>
      <code>DATABASE_URL=&lt;production&gt; npm run db:migrate</code>
    </div>
  );
}

// ---------------------------------------------------------------- departures

function DeparturesTab({ flash }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState(null);
  async function load() {
    try {
      const r = await apiFetch("/admin/settlements");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load settlements.");
      setData(j);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  if (err) return <div className="auth-error">{err}</div>;
  if (!data) return <div className="dash-empty">Loading…</div>;
  if (!data.available) return <NotOn migration="044" />;
  const changed = async (msg) => { await load(); if (msg) flash?.(msg); };
  return (
    <div className="dash-card pay-list">
      {data.items.length === 0 && <div className="dash-empty">No departures confirmed to run yet. A date appears here once it reaches GoAhead — then its operator can enter costs and receipts.</div>}
      {data.items.map((v) => (
        <div key={v.departure.id} className={openId === v.departure.id ? "pay-row open" : "pay-row"}>
          <button type="button" className="pay-row-head st-head" onClick={() => setOpenId(openId === v.departure.id ? null : v.departure.id)} aria-expanded={openId === v.departure.id}>
            <span className="pay-tour"><strong>{v.departure.route}</strong><em>{v.dateLabel} · run by {v.operatorName || "—"}</em></span>
            <span className="pay-money">{money(v.settlement.revenue)} in · {money(v.settlement.cost)} cost</span>
            <span className="pay-money"><b>{money(v.settlement.gross)}</b> profit</span>
            <span className="pay-stage"><span className={`tag ${v.blocker ? (v.blocker === "not_ended" ? "tag-off" : "tag-warn") : "tag-on"}`}>{v.blockerLabel || "Ready to pay"}</span></span>
            <ChevronDown size={16} className="pay-chev" aria-hidden="true" />
          </button>
          {openId === v.departure.id && <SettlementDetail v={v} data={data} onChanged={changed} />}
        </div>
      ))}
    </div>
  );
}

function SettlementDetail({ v, data, onChanged }) {
  const s = v.settlement;
  const pending = v.costs.filter((c) => c.state === "submitted").length;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn, msg) => {
    setErr(""); setBusy(true);
    try { await fn(); await onChanged(msg); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="pay-body st-body">
      <div className="st-figures">
        <div><span>Revenue collected</span><b>{money(s.revenue)}</b></div>
        <div><span>Extra income</span><b>{money(s.income || 0)}</b></div>
        <div><span>Approved costs</span><b>{money(s.cost)}</b></div>
        <div><span>Gross profit</span><b className={s.loss ? "st-neg" : ""}>{money(s.gross)}</b></div>
        <div><span>Sawa 10%</span><b>{money(s.sawaCut)}</b></div>
        <div><span>Shared by headcount</span><b>{money(s.pool)}</b></div>
      </div>

      <table className="dash-table st-table">
        <thead><tr><th>Party</th><th>Paid passengers</th><th>Share</th><th>Headcount share</th><th>Adjustments</th><th>Total</th><th>Paid out</th></tr></thead>
        <tbody>
          {s.shares.map((x) => (
            <tr key={x.agencyId}>
              <td><strong>{x.name}</strong>{x.agencyId === v.operatorAgencyId && <span className="tag st-op">Operator</span>}</td>
              <td>{x.seats}</td><td>{pct(x.pct)}</td><td>{money(x.share)}</td><td>{x.adjustments ? money(x.adjustments) : "—"}</td>
              <td><b>{money(x.total)}</b></td><td>{money(x.paidOut)}</td>
            </tr>
          ))}
          <tr className="row-total"><td><strong>Sawa</strong></td><td /><td>10%</td><td>{money(s.sawa.cut)}{s.sawa.remainder ? ` + ${money(s.sawa.remainder)} rounding` : ""}</td><td>{s.sawa.adjustments ? money(s.sawa.adjustments) : "—"}</td><td><b>{money(s.sawa.total)}</b></td><td /></tr>
          {s.shares.length === 0 && <tr><td colSpan={7}><div className="dash-empty">No paid passengers yet.</div></td></tr>}
        </tbody>
      </table>

      <div className="st-block">
        <div className="st-block-head">
          <strong>Cost sheet</strong>
          {v.costsFinalAt
            ? <><span className="tag tag-on"><Lock size={12} />Final</span><button type="button" className="btn-ghost sm" disabled={busy} onClick={() => act(() => send(`/admin/settlements/${v.departure.id}/costs-final`, { final: false }), "Cost sheet reopened.")}><Unlock size={14} />Reopen</button></>
            : <button type="button" className="btn-primary sm" disabled={busy || pending > 0} title={pending ? "Review every line first" : ""} onClick={() => act(() => send(`/admin/settlements/${v.departure.id}/costs-final`, { final: true }), "Cost sheet is final.")}><Lock size={14} />Mark cost sheet final</button>}
        </div>
        <ul className="pay-history">
          {sheetOrder(v.costs).map((c) => <CostLine key={c.id} c={c} categories={data.categories} final={!!v.costsFinalAt} onChanged={onChanged} />)}
          {v.costs.length === 0 && <li className="muted-line">No costs yet. The operator submits them from its portal, or add them here.</li>}
        </ul>
        {!v.costsFinalAt && <AddCost depId={v.departure.id} categories={data.categories} travellers={v.travellers} onChanged={onChanged} />}
      </div>

      {s.loss && (
        <div className="st-block st-loss">
          <strong>This departure made a loss of {money(-s.gross)}.</strong>
          {v.lossDecidedAt
            ? <p>Sawa's decision: {v.lossNote} <span className="muted-line">({fmtDate(v.lossDecidedAt)})</span></p>
            : <LossDecision depId={v.departure.id} onChanged={onChanged} />}
          <p className="field-hint">Record who absorbs it as adjustments below, then the decision.</p>
        </div>
      )}

      <div className="st-block">
        <strong>Sawa's adjustments</strong>
        <ul className="pay-history">
          {v.adjustments.map((a) => (
            <li key={a.id} className="pay-line"><div className="pay-line-main"><strong>{a.name}</strong> {money(a.amount)} <span className="muted-line">{a.reason} · {a.createdBy} · {fmtDate(a.createdAt)}</span></div></li>
          ))}
          {v.adjustments.length === 0 && <li className="muted-line">None. Use these for a loss or a non-refundable cost — a signed amount for one party, with the reason.</li>}
        </ul>
        <AddAdjustment depId={v.departure.id} parties={s.shares} agencies={data.agencies} onChanged={onChanged} />
      </div>
      {err && <p className="pay-err">{err}</p>}
    </div>
  );
}

function CostLine({ c, categories, final, onChanged }) {
  const [amount, setAmount] = useState(String(c.amount));
  const [note, setNote] = useState("");
  const [mode, setMode] = useState(null);
  const [err, setErr] = useState("");
  const label = categories.find((x) => x.id === c.category)?.label || c.category;
  async function review(decision) {
    setErr("");
    try {
      await send(`/admin/departure-costs/${c.id}/review`, { decision, approvedAmount: Number(amount), note });
      setMode(null);
      await onChanged(decision === "approve" ? "Cost approved." : "Cost rejected.");
    } catch (e) { setErr(e.message); }
  }
  return (
    <li className={`pay-line ${c.state === "rejected" ? "pay-void" : ""}`}>
      <div className="pay-line-main">
        <span><LineKind c={c} /><strong>{label}</strong> — {c.description}</span>
        <span>{costBreakdown(c)}{c.kind === "income" ? "+" : ""}{money(c.amount)}{c.state === "approved" && c.approvedAmount !== c.amount ? ` → approved ${money(c.approvedAmount)}` : ""}</span>
        <span className={`tag ${c.state === "approved" ? "tag-on" : c.state === "rejected" ? "tag-off" : "tag-warn"}`}>{c.state === "submitted" ? "To review" : c.state === "approved" ? "Approved" : "Rejected"}</span>
        <span className="muted-line">{c.submittedByAgencyId ? "operator" : "Sawa"}{c.reviewNote ? ` · ${c.reviewNote}` : ""}</span>
        <Receipt c={c} />
        {!final && c.state === "submitted" && !mode && (
          <span className="pay-acts"><button type="button" className="btn-ghost sm" onClick={() => setMode("review")}>Review</button></span>
        )}
      </div>
      {mode && c.state === "submitted" && !final && (
        <div className="pay-inline">
          <label className="st-inline-label">Approve {CURRENCY_SYMBOL}<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional) — e.g. why a different amount" />
          <button type="button" className="btn-primary sm" onClick={() => review("approve")}><Check size={14} />Approve</button>
          <button type="button" className="btn-ghost sm" onClick={() => review("reject")}><X size={14} />Reject</button>
          <button type="button" className="btn-ghost sm" onClick={() => setMode(null)}>Cancel</button>
          {err && <span className="pay-err">{err}</span>}
        </div>
      )}
    </li>
  );
}

// A cost line's receipt: an uploaded file, previewed on the line — a photo
// as a thumbnail, a PDF in an inline viewer that opens under the line — or a
// pasted link. Previews load through the same short-lived signed link; the
// file name still opens the full file in a new tab.
export function Receipt({ c }) {
  const [err, setErr] = useState("");
  const [url, setUrl] = useState(null);
  const [showPdf, setShowPdf] = useState(false);
  const kind = c.receiptKind;
  useEffect(() => {
    if (!c.receiptFile || kind !== "image") return undefined;
    let live = true;
    receiptLink(c.id).then((j) => { if (live) setUrl(j.url); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [c.id, c.receiptFile, kind]);
  async function togglePdf() {
    setErr("");
    if (showPdf) { setShowPdf(false); return; }
    try { setUrl((await receiptLink(c.id)).url); setShowPdf(true); } catch (e) { setErr(e.message); }
  }
  if (c.receiptFile) {
    const open = () => { setErr(""); openReceipt(c.id).catch((e) => setErr(e.message)); };
    return (
      <>
        {kind === "image" && (
          <button type="button" className="rc-thumb" onClick={open} title={`Open ${c.receiptFile}`} aria-label={`Open receipt ${c.receiptFile}`}>
            {url ? <img src={url} alt={`Receipt: ${c.receiptFile}`} /> : <Paperclip size={16} />}
          </button>
        )}
        {kind === "pdf" && (
          <button type="button" className="rc-pdf" onClick={togglePdf} aria-expanded={showPdf}>
            <FileText size={15} />PDF{showPdf ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button type="button" className="pay-link link-btn" title={c.receiptFile} onClick={open}>
          <Paperclip size={13} />{c.receiptFile}
        </button>
        {err && <span className="pay-err">{err}</span>}
        {kind === "pdf" && showPdf && url && (
          <iframe className="rc-frame" src={url} title={`Receipt: ${c.receiptFile}`} />
        )}
      </>
    );
  }
  if (c.receiptUrl) return <a className="pay-link" href={c.receiptUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />receipt</a>;
  return null;
}

// Transport and a guide cost the same whatever the headcount; meals, entrance
// fees and the like are paid per traveller. The type suggests one; either can
// be chosen.
const PER_PERSON_BY_DEFAULT = new Set(["meals", "entrance", "activities", "accommodation", "optional_tours"]);
const kindOf = (c) => c?.kind || "cost";

// One line on a cost sheet: money out (a cost, or a commission we pay) or
// money in (a shop commission, optional tours sold by the guide).
export function CostForm({ categories, onSubmit, submitLabel, travellers = null }) {
  const [kind, setKind] = useState("cost");
  const listed = categories.filter((c) => kindOf(c) === kind);
  const [category, setCategory] = useState(categories[0]?.id || "transport");
  const [basis, setBasis] = useState(PER_PERSON_BY_DEFAULT.has(categories[0]?.id) ? "person" : "group");
  const [basisTouched, setBasisTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("");
  const [people, setPeople] = useState(travellers ? String(travellers) : "");
  const [receiptUrl, setReceiptUrl] = useState("");
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0);   // resets the file input
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const person = basis === "person";
  const total = person ? Math.round(Number(unit) * Number(people) * 100) / 100 : Number(amount);
  const ready = description.trim() && total > 0 && (!person || (Number(unit) > 0 && Number.isInteger(Number(people)) && Number(people) >= 1));

  function pickCategory(id) {
    setCategory(id);
    if (!basisTouched) setBasis(PER_PERSON_BY_DEFAULT.has(id) ? "person" : "group");
  }
  function pickKind(k) {
    setKind(k);
    pickCategory(categories.find((c) => kindOf(c) === k)?.id || category);
  }
  const income = kind === "income";
  async function submit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      // The file goes up first; the cost line then points at it.
      const receipt = file ? (await uploadReceipt(file)).ref : receiptUrl || undefined;
      await onSubmit(person
        ? { category, description, basis, unitAmount: Number(unit), quantity: Number(people), receiptUrl: receipt }
        : { category, description, basis, amount: Number(amount), receiptUrl: receipt });
      setDescription(""); setAmount(""); setUnit(""); setReceiptUrl(""); setFile(null); setFileKey((k) => k + 1); setBasisTouched(false);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <form className={`pay-new st-costform ${income ? "cf-in" : ""}`} onSubmit={submit}>
      {categories.some((c) => kindOf(c) === "income") && (
        <div className="seg cf-kind" role="radiogroup" aria-label="Money out or money in">
          {[["cost", "Money out", "a cost, or a commission we pay"], ["income", "Money in", "a commission we receive, optional tours"]].map(([id, label, hint]) => (
            <button key={id} type="button" role="radio" aria-checked={kind === id} className={kind === id ? "active" : ""} onClick={() => pickKind(id)}>
              {id === "income" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}{label}<span className="cf-kind-hint">{hint}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cf-row cf-what">
        <label>Type<select value={category} onChange={(e) => pickCategory(e.target.value)}>{listed.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label>What<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={income ? "e.g. Papyrus shop, 10% of sales" : "e.g. Coach and driver, full day"} /></label>
      </div>
      <div className="cf-row cf-price">
        <div className="cf-field">
          <span className="cf-label">{income ? "Received" : "Charged"}</span>
          <div className="seg cf-basis" role="radiogroup" aria-label={income ? "Received per group or per person" : "Charged per group or per person"}>
            {[["group", "Per group"], ["person", "Per person"]].map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={basis === id} className={basis === id ? "active" : ""}
                onClick={() => { setBasis(id); setBasisTouched(true); }}>{label}</button>
            ))}
          </div>
        </div>
        {person ? (
          <>
            <label>{income ? "Amount" : "Price"} per person ({CURRENCY_SYMBOL})<input type="number" min="0.01" step="0.01" value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
            <div className="cf-people">
              <span className="cf-times" aria-hidden="true">×</span>
              <label>People<input type="number" min="1" step="1" value={people} onChange={(e) => setPeople(e.target.value)} /></label>
            </div>
            <div className="cf-field cf-total"><span className="cf-label">Total</span><b>{total > 0 ? `${CURRENCY_SYMBOL}${total.toLocaleString()}` : "—"}</b></div>
          </>
        ) : (
          <label>{income ? "Amount received" : "Total for the group"} ({CURRENCY_SYMBOL})<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        )}
      </div>
      {person && travellers != null && <p className="field-hint cf-hint">{travellers} traveller{travellers === 1 ? "" : "s"} booked on this date — change the number if it differs.</p>}
      <div className="cf-row cf-receipt">
        <label>{income ? "Proof (statement, invoice — optional)" : "Receipt (PDF or photo)"}
          <input key={fileKey} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
            onChange={(e) => { const f = e.target.files?.[0] || null; setErr(f && f.size > 8 * 1024 * 1024 ? "That file is larger than 8MB." : ""); setFile(f && f.size <= 8 * 1024 * 1024 ? f : null); }} />
        </label>
        {!file && (
          <label>…or paste a link instead
            <input type="url" value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} placeholder="https://… (optional)" />
          </label>
        )}
      </div>
      {err && <p className="pay-err">{err}</p>}
      <button className="btn-primary sm" type="submit" disabled={busy || !ready}><Plus size={14} />{busy ? (file ? "Uploading…" : "Saving…") : typeof submitLabel === "function" ? submitLabel(kind) : submitLabel}</button>
    </form>
  );
}

// Money out first, then money in; each in the order entered.
export const sheetOrder = (lines) => [...lines].sort((a, b) => (a.kind === "income") - (b.kind === "income"));
// The arrow in front of a line: money out, or money in.
export function LineKind({ c }) {
  return c.kind === "income"
    ? <span className="cf-dir cf-dir-in" title="Money in"><ArrowDownLeft size={13} />In</span>
    : <span className="cf-dir cf-dir-out" title="Money out"><ArrowUpRight size={13} />Out</span>;
}

// "€15 × 12 people" beside a per-person line's total.
export const costBreakdown = (c) => (c.basis === "person" && c.unitAmount && c.quantity
  ? `${CURRENCY_SYMBOL}${Number(c.unitAmount).toLocaleString()} × ${c.quantity} ${c.quantity === 1 ? "person" : "people"} = `
  : "");

function AddCost({ depId, categories, travellers, onChanged }) {
  return <CostForm categories={categories} travellers={travellers} submitLabel={(k) => (k === "income" ? "Add income (approved)" : "Add cost (approved)")}
    onSubmit={async (body) => { await send(`/admin/settlements/${depId}/costs`, body); await onChanged(categories.find((c) => c.id === body.category)?.kind === "income" ? "Income added." : "Cost added."); }} />;
}

function AddAdjustment({ depId, parties, agencies, onChanged }) {
  const [agencyId, setAgencyId] = useState(parties[0]?.agencyId || "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const options = [...new Map([...parties.map((p) => [p.agencyId, p.name]), ...Object.entries(agencies)]).entries()];
  async function submit(e) {
    e.preventDefault();
    setErr("");
    try {
      await send(`/admin/settlements/${depId}/adjustments`, { agencyId: agencyId || null, amount: Number(amount), reason });
      setAmount(""); setReason("");
      await onChanged("Adjustment recorded.");
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <form className="pay-inline st-adjust" onSubmit={submit}>
      <select value={agencyId} onChange={(e) => setAgencyId(e.target.value)} aria-label="Party">
        <option value="">Sawa</option>
        {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
      <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="± amount" aria-label="Amount" />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason — Sawa's decision on record" aria-label="Reason" />
      <button className="btn-ghost sm" type="submit" disabled={!Number(amount) || reason.trim().length < 3}><Plus size={14} />Add</button>
      {err && <span className="pay-err">{err}</span>}
    </form>
  );
}

function LossDecision({ depId, onChanged }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  return (
    <form className="pay-inline" onSubmit={async (e) => {
      e.preventDefault(); setErr("");
      try { await send(`/admin/settlements/${depId}/loss-decision`, { note }); await onChanged("Decision recorded."); } catch (e2) { setErr(e2.message); }
    }}>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sawa's decision — who absorbs the loss, and why" />
      <button className="btn-primary sm" type="submit" disabled={note.trim().length < 3}>Record decision</button>
      {err && <span className="pay-err">{err}</span>}
    </form>
  );
}

// ---------------------------------------------------------------- runs

function RunsTab({ flash }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [payDate, setPayDate] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      const r = await apiFetch("/admin/payout-runs");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load payouts.");
      setData(j);
      setPayDate((d) => d || j.nextPayDate || "");
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  async function run(fn, msg) {
    setErr(""); setBusy(true);
    try { await fn(); await load(); flash?.(msg); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  if (!data && !err) return <div className="dash-empty">Loading…</div>;
  if (data && !data.available) return <NotOn migration="044" />;
  return (
    <>
      <div className="dash-card st-build">
        <div>
          <strong>Build a Wednesday run</strong>
          <p className="field-hint">Includes every departure that ended by the Saturday before, with its cost sheet final (and any loss decided). Money collected by that Saturday is paid now; anything later is topped up on a following Wednesday. Rebuilding a draft recalculates it.</p>
        </div>
        <div className="pay-inline">
          <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} aria-label="Pay date (a Wednesday)" />
          <button className="btn-primary sm" disabled={busy || !payDate} onClick={() => run(() => send("/admin/payout-runs", { payDate }), `Run for ${fmtDate(payDate)} built.`)}>Build / rebuild draft</button>
        </div>
      </div>
      {err && <div className="auth-error">{err}</div>}
      {(data?.runs || []).map((r) => <RunCard key={r.id} r={r} busy={busy} onRun={run} />)}
      {data?.runs?.length === 0 && <div className="dash-empty">No runs yet.</div>}
    </>
  );
}

function RunCard({ r, busy, onRun }) {
  const [refs, setRefs] = useState({});
  const total = r.totals.reduce((n, t) => n + t.amount, 0);
  return (
    <div className="dash-card st-run">
      <div className="dash-card-head">
        <h2>Wednesday {fmtDate(r.payDate)} <span className={`tag ${r.state === "approved" ? "tag-on" : "tag-warn"}`}>{r.state === "approved" ? "Approved" : "Draft"}</span></h2>
        <span className="muted-line">tours ended by {fmtDate(new Date(Date.parse(r.payDate) - 4 * 86400000).toISOString().slice(0, 10))} · {money(total)}</span>
      </div>
      <table className="dash-table">
        <thead><tr><th>Agency</th><th>Departure</th><th>Owed</th><th>Paid before</th><th>This run</th></tr></thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td><td>{l.route}<div className="sub">{l.dateLabel}</div></td>
              <td>{money(l.detail?.owed)}</td><td>{money(l.detail?.previouslyPaid)}</td><td><b>{money(l.amount)}</b></td>
            </tr>
          ))}
          {r.lines.length === 0 && <tr><td colSpan={5}><div className="dash-empty">Nothing to pay this week.</div></td></tr>}
        </tbody>
      </table>
      {r.state === "draft" && r.lines.length > 0 && (
        <button className="btn-primary sm" disabled={busy} onClick={() => { if (window.confirm(`Approve the ${fmtDate(r.payDate)} run for ${money(total)}? It can't be changed afterwards — later corrections go into a following run.`)) onRun(() => send(`/admin/payout-runs/${r.id}/approve`), "Run approved — transfers are due."); }}>
          <Check size={14} />Approve run
        </button>
      )}
      {r.transfers.length > 0 && (
        <ul className="pay-history">
          {r.transfers.map((t) => (
            <li key={t.id} className="pay-line"><div className="pay-line-main">
              <strong>{t.name}</strong> <span>{money(t.amount)}{t.amount < 0 ? " owed back to Sawa" : ""}</span>
              <span className={`tag ${t.state === "paid" ? "tag-on" : "tag-warn"}`}>{t.state === "paid" ? "Paid" : "Due"}</span>
              {t.state === "paid" && <span className="muted-line">ref {t.bankReference}</span>}
              {t.state === "due" && (
                <span className="pay-acts">
                  <input value={refs[t.id] || ""} onChange={(e) => setRefs({ ...refs, [t.id]: e.target.value })} placeholder="Bank reference" />
                  <button className="btn-ghost sm" disabled={busy || !(refs[t.id] || "").trim()} onClick={() => onRun(() => send(`/admin/payout-transfers/${t.id}/paid`, { reference: refs[t.id] }), `${t.name} marked paid.`)}><Check size={14} />Mark paid</button>
                </span>
              )}
            </div></li>
          ))}
        </ul>
      )}
    </div>
  );
}
