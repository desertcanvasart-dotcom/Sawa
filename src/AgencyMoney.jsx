// Agency portal → Money (044): what the agency is owed per departure, what has
// been paid and when, and — on a date it operates — its cost sheet.
//
// The model, stated on the page because it decides what the agency earns:
// revenue collected − approved costs = gross profit; Sawa takes 10%; the rest
// is shared by headcount (paid passengers). Paid every Wednesday for tours
// that ended by the Saturday before; money that arrives later is topped up on
// a following Wednesday. Sawa approves every cost.
import React, { useEffect, useState } from "react";
import { apiFetch } from "./supabaseClient";
import { fmtDate } from "./dates.js";
import { CURRENCY_SYMBOL } from "../shared/currency.js";
import { CostForm, Receipt } from "./AdminSettlements.jsx";

const money = (n) => (n == null ? "—" : `${Number(n) < 0 ? "−" : ""}${CURRENCY_SYMBOL}${Math.abs(Number(n)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const pct = (p) => `${Math.round(p * 1000) / 10}%`;

export function AgencyMoney() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  async function load() {
    try {
      const r = await apiFetch("/agency/money");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load your money.");
      setData(j);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  const owed = (data?.departures || []).reduce((n, d) => n + Math.max(0, (d.mine?.total || 0) - (d.mine?.paidOut || 0)), 0);
  const paid = (data?.transfers || []).filter((t) => t.state === "paid").reduce((n, t) => n + t.amount, 0);
  const due = (data?.transfers || []).filter((t) => t.state === "due").reduce((n, t) => n + t.amount, 0);

  return (
    <>
      <div className="dash-head"><div><h1>Money</h1><p>Your share of every departure your travellers joined, and your Wednesday payouts.</p></div></div>
      {err && <div className="auth-error">{err}</div>}
      {data && !data.available && <div className="dash-card pay-off"><strong>Payouts aren't switched on yet.</strong><p>Sawa is setting this up — your figures will appear here.</p></div>}
      {data?.available && (
        <>
          <div className="kpi-grid">
            <div className="kpi"><div className="kpi-top"><span>Paid to you</span></div><strong>{money(paid)}</strong><p>all Wednesdays so far</p></div>
            <div className="kpi kpi-accent"><div className="kpi-top"><span>Approved, being paid</span></div><strong>{money(due)}</strong><p>in approved Wednesday runs</p></div>
            <div className="kpi"><div className="kpi-top"><span>Still to come</span></div><strong>{money(owed)}</strong><p>next run: Wednesday {fmtDate(data.nextPayDate)}</p></div>
          </div>
          <div className="dash-card mn-how">
            <strong>How your share is worked out</strong>
            <p>For each departure: revenue collected − costs approved by Sawa = gross profit. Sawa takes 10%, and the other 90% is shared by headcount — each agency's share of the paid passengers (refunded passengers don't count). Payouts go out every Wednesday for tours that ended by the Saturday before; money that arrives later is added on a following Wednesday.</p>
          </div>

          <h2 className="mn-h2">Departures</h2>
          {data.departures.length === 0 && <div className="dash-empty">No departures yet. A date appears here once it's confirmed to run (GoAhead) — with your share, and, on dates you operate, your cost sheet for costs and receipts.</div>}
          {data.departures.map((d) => <DepartureCard key={d.departure.id} d={d} categories={data.categories} onChanged={load} />)}

          <h2 className="mn-h2">Payouts</h2>
          <div className="table-wrap">
            <table className="dash-table">
              <thead><tr><th>Wednesday</th><th>Amount</th><th>Status</th><th>Bank reference</th></tr></thead>
              <tbody>
                {data.transfers.map((t) => (
                  <tr key={t.id}>
                    <td>{fmtDate(t.payDate)}</td>
                    <td><b>{money(t.amount)}</b>{t.amount < 0 && <div className="sub">owed back to Sawa</div>}</td>
                    <td><span className={`tag ${t.state === "paid" ? "tag-on" : "tag-warn"}`}>{t.state === "paid" ? "Paid" : "Being paid"}</span></td>
                    <td>{t.bankReference || "—"}</td>
                  </tr>
                ))}
                {data.transfers.length === 0 && <tr><td colSpan={4}><div className="dash-empty">No payouts yet.</div></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!data && !err && <div className="dash-empty">Loading…</div>}
    </>
  );
}

function DepartureCard({ d, categories, onChanged }) {
  const m = d.mine;
  const left = m ? Math.round((m.total - m.paidOut) * 100) / 100 : 0;
  const status = d.blockerLabel || (left > 0.004 ? "Due next Wednesday" : left < -0.004 ? "Correction due" : "Paid");
  return (
    <div className="dash-card mn-dep">
      <div className="dash-card-head">
        <div><h2>{d.departure.route}</h2><div className="sub">{d.dateLabel} · run by {d.operatorName || "—"}{d.operating ? " (you)" : ""}</div></div>
        <span className={`tag ${d.blockerLabel ? "tag-warn" : left > 0.004 ? "tag-warn" : "tag-on"}`}>{status}</span>
      </div>
      <div className="st-figures">
        <div><span>Revenue collected</span><b>{money(d.revenue)}</b></div>
        <div><span>Approved costs</span><b>{money(d.cost)}</b></div>
        <div><span>Gross profit</span><b className={d.loss ? "st-neg" : ""}>{money(d.gross)}</b></div>
        <div><span>Sawa 10%</span><b>{money(d.sawaCut)}</b></div>
        {m && <div className="mn-mine"><span>Your share</span><b>{money(m.total)}</b><em>{m.seats} of {d.totalSeats} paid passengers · {pct(m.pct)}{m.adjustments ? ` · ${money(m.adjustments)} adjusted` : ""}</em></div>}
        {m && <div><span>Paid to you</span><b>{money(m.paidOut)}</b></div>}
      </div>
      {d.adjustments.length > 0 && (
        <ul className="pay-history">{d.adjustments.map((a) => <li key={a.id} className="pay-line"><div className="pay-line-main">Adjustment {money(a.amount)} <span className="muted-line">{a.reason}</span></div></li>)}</ul>
      )}
      {d.operating && (
        <div className="st-block">
          <strong>Your cost sheet {d.costsFinal && <span className="tag tag-on">Final</span>}</strong>
          <p className="field-hint">Enter the real cost of running this date, and attach the receipt (a PDF or a photo) where you have one. Sawa reviews every line before the profit is shared.</p>
          <ul className="pay-history">
            {d.costs.map((c) => (
              <li key={c.id} className={`pay-line ${c.state === "rejected" ? "pay-void" : ""}`}><div className="pay-line-main">
                <span><strong>{categories.find((x) => x.id === c.category)?.label || c.category}</strong> — {c.description}</span>
                <span>{money(c.amount)}{c.state === "approved" && c.approvedAmount !== c.amount ? ` → approved ${money(c.approvedAmount)}` : ""}</span>
                <span className={`tag ${c.state === "approved" ? "tag-on" : c.state === "rejected" ? "tag-off" : "tag-warn"}`}>{c.state === "submitted" ? "With Sawa" : c.state === "approved" ? "Approved" : "Rejected"}</span>
                {c.reviewNote && <span className="muted-line">{c.reviewNote}</span>}
                <Receipt c={c} />
              </div></li>
            ))}
            {d.costs.length === 0 && <li className="muted-line">No costs entered yet.</li>}
          </ul>
          {!d.costsFinal && (
            <CostForm categories={categories} submitLabel="Submit cost to Sawa"
              onSubmit={async (body) => {
                const r = await apiFetch(`/agency/departures/${d.departure.id}/costs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.error || "Could not submit the cost.");
                await onChanged();
              }} />
          )}
        </div>
      )}
    </div>
  );
}
