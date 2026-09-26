// Admin → Payments: the Tab payment-link queue (043).
//
// Ops make a link in Tab, paste it here and Sawa emails it to the customer;
// when Tab shows the payment, ops mark it paid with Tab's reference. The queue
// shows what needs doing first. The rules behind every stage are in
// server/payments.js.
import React, { useEffect, useMemo, useState } from "react";
import { Check, X, Send, RotateCcw, ExternalLink, ChevronDown } from "lucide-react";
import { apiFetch } from "./supabaseClient";
import { fmtDate } from "./dates.js";
import { CURRENCY_SYMBOL } from "../shared/currency.js";

const money = (n) => (n == null ? "—" : `${CURRENCY_SYMBOL}${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const when = (iso) => (iso ? new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo",
}).format(new Date(iso)) : "—");
const KIND = { deposit: "Deposit", balance: "Balance", full: "Full payment" };
const STATE = { link_sent: "Link sent", paid: "Paid", void: "Void", refunded: "Refunded" };

// Which tab each stage belongs to. "To do" is anything asking ops to act.
const TABS = [
  { id: "todo", label: "To do", has: (i) => !!i.summary.action },
  { id: "waiting", label: "Awaiting payment", has: (i) => i.summary.stage === "link_sent" },
  { id: "paid", label: "Paid", has: (i) => ["deposit_paid", "paid_in_full"].includes(i.summary.stage) },
  { id: "all", label: "All", has: () => true },
];
const STAGE_TONE = {
  deposit_link_needed: "tag-warn", balance_link_needed: "tag-warn", overdue: "tag-alert",
  link_sent: "", deposit_paid: "tag-on", paid_in_full: "tag-on", cancelled: "tag-off", not_due: "tag-off",
};

async function send(path, body) {
  const r = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

export function PaymentsSection({ flash }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("todo");
  const [openId, setOpenId] = useState(null);

  async function load() {
    try {
      const r = await apiFetch("/admin/payments");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load payments.");
      setData(j);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  const items = data?.items || [];
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.id, items.filter(t.has).length])), [items]);
  const shown = items.filter(TABS.find((t) => t.id === tab).has);

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Payments</h1>
          <p>Make the link in Tab, paste it here and we email it to the customer. Mark it paid with Tab's reference once it arrives.</p>
        </div>
      </div>
      {err && <div className="auth-error">{err}</div>}
      {data && !data.available && (
        <div className="dash-card pay-off">
          <strong>Payments aren't switched on yet.</strong>
          <p>The payments table (migration 043) hasn't been added to the database. Run this once against production, then reload:</p>
          <code>DATABASE_URL=&lt;production&gt; npm run db:migrate</code>
        </div>
      )}
      {data?.available && (
        <>
          <div className="seg pay-tabs" role="tablist" aria-label="Filter payments">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                {t.label}<span className="pay-count">{counts[t.id]}</span>
              </button>
            ))}
          </div>
          <div className="dash-card pay-list">
            {shown.length === 0 && <div className="dash-empty">{tab === "todo" ? "Nothing to do — every confirmed booking has its link." : "Nothing here."}</div>}
            {shown.map((i) => (
              <PaymentRow key={i.pledge.id} item={i} open={openId === i.pledge.id}
                onToggle={() => setOpenId(openId === i.pledge.id ? null : i.pledge.id)}
                onChanged={async (msg) => { await load(); if (msg) flash?.(msg); }} />
            ))}
          </div>
        </>
      )}
      {!data && !err && <div className="dash-empty">Loading payments…</div>}
    </>
  );
}

function PaymentRow({ item, open, onToggle, onChanged }) {
  const { pledge, departure, summary, payments } = item;
  const who = pledge.agencyId && pledge.agencyId !== "direct_customer" ? pledge.agency : "Direct";
  return (
    <div className={open ? "pay-row open" : "pay-row"}>
      <button type="button" className="pay-row-head" onClick={onToggle} aria-expanded={open}>
        <span className="pay-who">
          <strong>{pledge.customers || "—"}</strong>
          <em>{who}{pledge.bookingCode ? ` · ${pledge.bookingCode}` : ""} · {pledge.seats} seat{pledge.seats === 1 ? "" : "s"}</em>
        </span>
        <span className="pay-tour"><strong>{departure.route}</strong><em>{item.dateLabel}</em></span>
        <span className="pay-money"><b>{money(summary.paid)}</b> of {money(summary.total)}</span>
        <span className="pay-stage">
          <span className={`tag ${STAGE_TONE[summary.stage] || ""}`}>{summary.label}</span>
          {summary.open && <em>due {when(summary.open.dueAt)}</em>}
        </span>
        <ChevronDown size={16} className="pay-chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="pay-body">
          <div className="pay-contact">
            {pledge.customerEmail ? <a href={`mailto:${pledge.customerEmail}`}>{pledge.customerEmail}</a> : <span className="muted-line">No email on this booking</span>}
            {pledge.customerPhone && <span>{pledge.customerPhone}</span>}
            <span>Deposit quoted {money(pledge.depositDue)} · balance due {pledge.balanceDueDate ? fmtDate(pledge.balanceDueDate) : "—"}</span>
          </div>
          {payments.length > 0 && (
            <ul className="pay-history">
              {payments.map((p) => <PaymentLine key={p.id} p={p} onChanged={onChanged} />)}
            </ul>
          )}
          {pledge.status !== "cancelled" && summary.outstanding > 0 && (
            <NewLinkForm item={item} onChanged={onChanged} />
          )}
        </div>
      )}
    </div>
  );
}

function PaymentLine({ p, onChanged }) {
  const [mode, setMode] = useState(null); // paid | void | refund
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      if (mode === "paid") await send(`/admin/payments/${p.id}/paid`, { reference: text });
      if (mode === "void") await send(`/admin/payments/${p.id}/void`, { reason: text });
      if (mode === "refund") await send(`/admin/payments/${p.id}/refund`, { reference: text });
      setMode(null); setText("");
      await onChanged(mode === "paid" ? "Marked paid — the customer has been thanked." : mode === "void" ? "Link voided." : "Refund recorded.");
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <li className={`pay-line pay-${p.state}`}>
      <div className="pay-line-main">
        <span><strong>{KIND[p.kind]}</strong> {money(p.amount)}</span>
        <span className="tag">{STATE[p.state]}</span>
        <span className="muted-line">
          sent {when(p.linkSentAt)}
          {p.state === "link_sent" && ` · due ${when(p.dueAt)}`}
          {p.state === "paid" && ` · paid ${when(p.paidAt)} · ref ${p.providerReference}`}
          {p.state === "refunded" && ` · refunded ${when(p.refundedAt)} · ref ${p.refundReference}`}
          {p.state === "void" && p.voidReason && ` · ${p.voidReason}`}
          {!p.emailedTo && " · not emailed (no address)"}
        </span>
        <a className="pay-link" href={p.linkUrl} target="_blank" rel="noopener noreferrer" title={p.linkUrl}><ExternalLink size={13} />link</a>
        {!mode && p.state === "link_sent" && (
          <span className="pay-acts">
            <button type="button" className="btn-ghost sm" onClick={() => setMode("paid")}><Check size={14} />Mark paid</button>
            <button type="button" className="btn-ghost sm" onClick={() => setMode("void")}><X size={14} />Void</button>
          </span>
        )}
        {!mode && p.state === "paid" && (
          <span className="pay-acts"><button type="button" className="btn-ghost sm" onClick={() => setMode("refund")}><RotateCcw size={14} />Refund</button></span>
        )}
      </div>
      {mode && (
        <form className="pay-inline" onSubmit={submit}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
            placeholder={mode === "void" ? "Reason (optional) — e.g. wrong amount" : mode === "paid" ? "Tab payment reference" : "Tab refund reference"} />
          <button className="btn-primary sm" type="submit" disabled={busy || (mode !== "void" && !text.trim())}>
            {busy ? "Saving…" : mode === "paid" ? "Confirm paid" : mode === "void" ? "Void link" : "Record refund"}
          </button>
          <button type="button" className="btn-ghost sm" onClick={() => { setMode(null); setErr(""); }}>Cancel</button>
          {err && <span className="pay-err">{err}</span>}
        </form>
      )}
    </li>
  );
}

function NewLinkForm({ item, onChanged }) {
  const { pledge, summary, payments, defaults } = item;
  const suggested = summary.stage === "balance_link_needed" || summary.paid > 0 ? "balance" : "deposit";
  const [kind, setKind] = useState(suggested);
  const [amount, setAmount] = useState(String(defaults[suggested] ?? ""));
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const blocked = payments.some((p) => p.state === "link_sent" && p.kind === kind);

  async function submit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const j = await send(`/admin/bookings/${pledge.id}/payment-links`, { kind, url, amount: Number(amount) });
      setUrl("");
      await onChanged(j.emailed ? `${KIND[kind]} link emailed to ${pledge.customerEmail}.` : `${KIND[kind]} link saved — there's no email on this booking, so send it to the customer yourself.`);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form className="pay-new" onSubmit={submit}>
      <strong>Send a Tab payment link</strong>
      <div className="pay-new-row">
        <label>Type
          <select value={kind} onChange={(e) => { setKind(e.target.value); setAmount(String(defaults[e.target.value] ?? "")); }}>
            <option value="deposit">Deposit</option>
            <option value="balance">Balance</option>
            <option value="full">Full payment</option>
          </select>
        </label>
        <label>Amount ({CURRENCY_SYMBOL})
          <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="pay-url">Tab link
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (copy it from Tab)" />
        </label>
      </div>
      <p className="field-hint">
        Make the link in Tab for exactly this amount, then paste it here.
        {pledge.customerEmail ? ` We'll email it to ${pledge.customerEmail} with the payment deadline.` : " There's no email on this booking, so send it to the customer yourself."}
        {" "}Outstanding: {money(summary.outstanding)}.
      </p>
      {blocked && <p className="pay-err">A {KIND[kind].toLowerCase()} link is already out. Void it first if it was wrong.</p>}
      {err && <p className="pay-err">{err}</p>}
      <button className="btn-primary sm" type="submit" disabled={busy || blocked || !url.trim() || !(Number(amount) > 0)}>
        <Send size={14} />{busy ? "Sending…" : pledge.customerEmail ? "Send link to customer" : "Save link"}
      </button>
    </form>
  );
}
