// Admin → Finance (model phase 3): what is owed and what was paid (operator
// advances and balances, agency commission statements, agency invoices), the
// margin report, agency commission and billing, and the reference tables
// (exchange rates, public holidays, penalty amounts, payment fees). Records
// only: finance pays by bank transfer and records it here.
import React, { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { apiFetch } from "./supabaseClient";
import { PayAtGoAhead, CancellationTiers, LossWarnings, UnlinkedBanner, TermsVersions } from "./AdminPayAtGoAhead";

const money = (currency, n) => (n == null ? "—" : `${currency} ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dayLabel = (ymd) => (ymd ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T12:00:00Z`)) : "—");
const STANDING_TONE = { due: "", overdue: "tag-off", paid: "tag-on", on_hold: "tag-warn", draft: "tag-warn" };
const STANDING_LABEL = { due: "Due", overdue: "Overdue", paid: "Paid", offset: "Set off", on_hold: "On hold", draft: "Draft" };

async function call(path, method = "GET", body) {
  const r = await apiFetch(path, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "That didn't work. Please try again."), { warning: j.warning, status: r.status });
  return j;
}

export function FinanceSection({ flash, isSuperAdmin }) {
  const [tab, setTab] = useState("owed");
  const tabs = [["owed", "Owed and paid"], ["pay", "Pay at GoAhead"], ["commissions", "Agency commission"], ["margin", "Margin"],
    ["tiers", "Tiers and Terms"], ["settings", "Rates and settings"]];
  return (
    <>
      <div className="dash-head"><div><h1>Finance</h1><p>Operator advances and balances, agency commission and invoices. Finance pays by bank transfer and records each payment here.</p></div></div>
      <div className="cat-actions" style={{ justifyContent: "flex-start", marginBottom: 12 }}>
        {tabs.map(([k, label]) => <button key={k} className={tab === k ? "btn-primary sm" : "btn-ghost sm"} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab !== "pay" && <UnlinkedBanner onOpen={() => setTab("pay")} />}
      {tab === "owed" && <Owed flash={flash} isSuperAdmin={isSuperAdmin} />}
      {tab === "pay" && <PayAtGoAhead flash={flash} isSuperAdmin={isSuperAdmin} />}
      {tab === "tiers" && <><CancellationTiers flash={flash} isSuperAdmin={isSuperAdmin} /><TermsVersions flash={flash} isSuperAdmin={isSuperAdmin} /></>}
      {tab === "commissions" && <Commissions flash={flash} isSuperAdmin={isSuperAdmin} />}
      {tab === "margin" && <Margin />}
      {tab === "settings" && <Settings flash={flash} />}
    </>
  );
}

function Owed({ flash, isSuperAdmin }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [filters, setFilters] = useState({ from: "", to: "", party: "", standing: "" });
  const [paying, setPaying] = useState(null);

  async function load() {
    try {
      setErr("");
      const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
      setData(await call(`/admin/finance?${q}`));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [filters.from, filters.to, filters.standing]);

  return (
    <>
      {err && <div className="auth-error">{err}</div>}
      {data?.overdue?.overdue > 0 && (
        <div className="auth-error" role="status"><AlertTriangle size={14} /> {data.overdue.overdue} overdue ({data.overdue.operator} to operators, {data.overdue.agency} with agencies).</div>
      )}
      {data?.receivables?.length > 0 && (
        <div className="dash-card" style={{ marginBottom: 12 }}>
          <h2>Owed to Sawa by operators</h2>
          <p className="field-hint">Set off automatically against each operator's next advance or balance (clause 9.4), or repaid by transfer.</p>
          <table className="dash-table"><tbody>{data.receivables.map((r) => (
            <tr key={r.operatorId}><td>{r.name}</td><td className="tnum">{money("EGP", r.outstandingEgp)}</td><td className="field-hint">{r.count} item{r.count === 1 ? "" : "s"}</td></tr>
          ))}</tbody></table>
        </div>
      )}
      {data?.legacy && (
        <p className="field-hint">Legacy departures (existing settlement tools): <b>{data.legacy.open}</b> still open{data.legacy.lastDate ? <>, the last on <b>{dayLabel(data.legacy.lastDate)}</b></> : ""}.</p>
      )}
      <form className="form-grid" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label className="field"><span>Due from</span><input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
        <label className="field"><span>Due to</span><input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
        <label className="field"><span>Party</span><input value={filters.party} onChange={(e) => setFilters({ ...filters, party: e.target.value })} placeholder="Operator or agency name" onBlur={load} /></label>
        <label className="field"><span>Status</span>
          <select value={filters.standing} onChange={(e) => setFilters({ ...filters, standing: e.target.value })}>
            <option value="">All</option>{Object.entries(STANDING_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </form>
      {paying && <PaymentForm item={paying} isSuperAdmin={isSuperAdmin} onClose={() => setPaying(null)} onDone={() => { setPaying(null); flash("Payment recorded."); load(); }} />}
      {data && (data.items.length ? (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>Due</th><th>What</th><th>Party</th><th>Departure</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={`${i.kind}:${i.id}`}>
                  <td>{dayLabel(i.dueOn)}</td>
                  <td>{i.type}{i.direction === "in" && <div className="field-hint">money in</div>}</td>
                  <td>{i.party.name}</td>
                  <td>{i.departure ? <>{i.departure.label}<div className="field-hint">{dayLabel(i.departure.date)}</div></> : "—"}</td>
                  <td className="tnum">{money(i.currency, i.amount)}
                    {i.setoffEgp > 0 && <div className="field-hint">{money(i.currency, i.grossAmount)} less {money(i.currency, i.setoffEgp)} set off</div>}
                    {i.kind === "operator_receivable" && i.grossAmount !== i.amount && <div className="field-hint">of {money(i.currency, i.grossAmount)}</div>}</td>
                  <td>
                    <span className={`tag ${STANDING_TONE[i.standing]}`}>{STANDING_LABEL[i.standing]}</span>
                    {i.holdReason && <div className="field-hint">{i.holdReason}</div>}
                    {i.payment && <div className="field-hint">{money(i.currency, i.payment.amount)} on {dayLabel(i.payment.paidOn)}, ref {i.payment.bankReference}{i.payment.differs ? ` (differs; approved by ${i.payment.overrideBy})` : ""}</div>}
                  </td>
                  <td className="row-actions">{(i.standing === "due" || i.standing === "overdue") && <button className="btn-ghost sm" onClick={() => setPaying(i)}>{i.direction === "in" ? "Record money received" : "Record payment"}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="dash-empty">Nothing owed in this range.</div>)}
    </>
  );
}

function PaymentForm({ item, isSuperAdmin, onClose, onDone }) {
  const [f, setF] = useState({ amount: item.amount ?? "", paidOn: new Date().toISOString().slice(0, 10), bankReference: "", overrideReason: "" });
  const [warning, setWarning] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e, override = false) {
    e?.preventDefault();
    setBusy(true); setErr("");
    try {
      await call("/admin/finance/payments", "POST", {
        kind: item.kind, id: item.id, amount: Number(f.amount), paidOn: f.paidOn, bankReference: f.bankReference,
        ...(override ? { override: true, overrideReason: f.overrideReason } : {}),
      });
      onDone();
    } catch (e2) {
      if (e2.warning) setWarning(e2.warning);
      setErr(e2.message);
    } finally { setBusy(false); }
  }
  return (
    <form className="dash-card" onSubmit={submit} style={{ marginBottom: 12 }}>
      <h2>Record payment: {item.type}, {item.party.name}</h2>
      <p className="field-hint">{item.kind === "operator_receivable"
        ? `Outstanding: ${money(item.currency, item.amount)}. The operator may repay in parts.`
        : `Due: ${money(item.currency, item.amount)}${item.party.kind === "operator" ? ". Paid to the operator's verified bank account." : ""}`}</p>
      {err && <div className="auth-error">{err}</div>}
      <div className="form-grid">
        <label className="field"><span>Amount ({item.currency})</span><input type="number" step="0.01" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></label>
        <label className="field"><span>Transfer date</span><input type="date" value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} required /></label>
        <label className="field"><span>Bank reference</span><input value={f.bankReference} onChange={(e) => setF({ ...f, bankReference: e.target.value })} required minLength={2} /></label>
      </div>
      {warning && (isSuperAdmin ? (
        <label className="field field-full"><span>Reason for recording a different amount</span>
          <input value={f.overrideReason} onChange={(e) => setF({ ...f, overrideReason: e.target.value })} required />
        </label>
      ) : <p className="field-hint">Only a super admin can record an amount that differs from what is due.</p>)}
      <div className="cat-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        {warning && isSuperAdmin
          ? <button type="button" className="btn-primary" disabled={busy || !f.overrideReason.trim()} onClick={(e) => submit(e, true)}>Record the different amount</button>
          : <button className="btn-primary" disabled={busy}>Record payment</button>}
      </div>
    </form>
  );
}

function Commissions({ flash, isSuperAdmin }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [agencyId, setAgencyId] = useState("");
  async function load() {
    try { setErr(""); setData(await call(`/admin/commissions${agencyId ? `?agencyId=${encodeURIComponent(agencyId)}` : ""}`)); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [agencyId]);
  async function saveBilling(a, patch) {
    try { await call(`/admin/agencies/${encodeURIComponent(a.id)}/billing`, "PATCH", patch); flash("Saved."); load(); } catch (e) { setErr(e.message); }
  }
  return (
    <>
      {err && <div className="auth-error">{err}</div>}
      {data && (
        <>
          <label className="field" style={{ maxWidth: 320, marginBottom: 12 }}><span>Agency</span>
            <select value={agencyId} onChange={(e) => setAgencyId(e.target.value)}>
              <option value="">All agencies</option>{data.agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <div className="dash-card" style={{ marginBottom: 12 }}>
            <h2>Statements</h2>
            <p className="field-hint">Monthly, sent by the 10th for the previous month. Egyptian agencies are shown in EGP at the rate on the statement date.</p>
            {data.statements.length ? (
              <table className="dash-table">
                <thead><tr><th>Period</th><th>Agency</th><th>Seats</th><th>Total</th><th>State</th></tr></thead>
                <tbody>{data.statements.map((s) => (
                  <tr key={s.id}>
                    <td>{s.period}</td><td>{data.agencies.find((a) => a.id === s.agencyId)?.name || s.agencyId}</td>
                    <td className="tnum">{s.lines.reduce((n, l) => n + l.seats, 0)}</td>
                    <td className="tnum">{money("EUR", s.totalEur)}{s.currency === "EGP" && <div className="field-hint">{s.totalEgp == null ? "EGP: rate missing" : `${money("EGP", s.totalEgp)} at ${s.egpPerEur} (${s.fxDay})`}</div>}</td>
                    <td>{s.state}{s.holdReason && <div className="field-hint">{s.holdReason}</div>}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="field-hint">No statements yet.</p>}
          </div>
          <div className="dash-card" style={{ marginBottom: 12 }}>
            <h2>Seats</h2>
            {data.commissions.length ? (
              <table className="dash-table">
                <thead><tr><th>Date</th><th>Product</th><th>Agency</th><th>Seats</th><th>Locked</th><th>Earned</th><th>Status</th></tr></thead>
                <tbody>{data.commissions.map((c) => (
                  <tr key={c.pledgeId}>
                    <td>{dayLabel(c.date)}</td><td>{c.product}</td><td>{c.agencyName}</td><td className="tnum">{c.seats}</td>
                    <td className="tnum">{c.perSeatEur == null ? "rate missing" : `${money("EUR", c.perSeatEur)} × ${c.seats}`}</td>
                    <td className="tnum">{money("EUR", c.earnedEur)}</td>
                    <td>{c.state}{c.stateReason && <div className="field-hint">{c.stateReason}</div>}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="field-hint">No agency commissions yet.</p>}
          </div>
          <div className="dash-card">
            <h2>Agency billing</h2>
            <p className="field-hint">An approved agency is invoiced the published price less its commission at booking; its seats count toward GoAhead from booking. {isSuperAdmin ? "" : "A super admin changes these."}</p>
            <table className="dash-table">
              <thead><tr><th>Agency</th><th>Country</th><th>Billing</th><th>Due after (days)</th></tr></thead>
              <tbody>{data.agencies.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td><input style={{ width: 60 }} defaultValue={a.countryCode || ""} maxLength={2} disabled={!isSuperAdmin} placeholder="EG"
                    onBlur={(e) => { const v = e.target.value.trim().toUpperCase(); if (v !== (a.countryCode || "")) saveBilling(a, { countryCode: v || null }); }} /></td>
                  <td><input type="checkbox" checked={a.billingApproved} disabled={!isSuperAdmin} onChange={(e) => saveBilling(a, { billingApproved: e.target.checked })} /> approved</td>
                  <td><input type="number" min="0" max="120" style={{ width: 80 }} defaultValue={a.billingDueDays} disabled={!isSuperAdmin}
                    onBlur={(e) => { const v = Number(e.target.value); if (v !== a.billingDueDays) saveBilling(a, { billingDueDays: v }); }} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Margin() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { call(`/admin/finance/margin?from=${from}&to=${to}`).then(setData).catch((e) => setErr(e.message)); }, [from, to]);
  return (
    <>
      {err && <div className="auth-error">{err}</div>}
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <label className="field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <p className="field-hint">EUR charged, less the operator amount (EGP converted at the CBE rate on each charge date), commissions and payment fees. A date with no rate shows "rate missing": nothing is estimated.</p>
      {data && (data.rows.length ? (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>Departure</th><th>Charged</th><th>Operator</th><th>Commissions</th><th>Fees</th><th>Margin</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.departure.id}>
                <td>{r.departure.label}<div className="field-hint">{dayLabel(r.departure.date)} · {r.departure.status}</div><LossWarnings warnings={r.lossWarnings} /></td>
                <td className="tnum">{money("EUR", r.revenueEur)}</td>
                <td className="tnum">{money("EGP", r.operatorEgp)}<div className="field-hint">{r.operatorEur == null ? "" : money("EUR", r.operatorEur)}</div></td>
                <td className="tnum">{money("EUR", r.commissionsEur)}</td>
                <td className="tnum">{r.feesMissing ? <span className="field-hint">fee rate not set</span> : money("EUR", r.feesEur)}</td>
                <td className="tnum">{r.margin == null
                  ? <span className="tag tag-warn">{r.problem}{r.missingRates?.length ? `: ${r.missingRates.join(", ")}` : ""}</span>
                  : <b>{money("EUR", r.margin)}</b>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <div className="dash-empty">No going-ahead or completed catalog departures in this range.</div>)}
    </>
  );
}

function Settings({ flash }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [fx, setFx] = useState({ day: new Date().toISOString().slice(0, 10), rate: "" });
  const [hol, setHol] = useState({ day: "", name: "" });
  const [fees, setFees] = useState({ percent: "", fixedEur: "" });
  async function load() {
    try {
      const j = await call("/admin/finance/settings");
      setData(j);
      if (j.fees) setFees({ percent: j.fees.percent, fixedEur: j.fees.fixedEur });
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  const run = async (fn, msg) => { setErr(""); try { await fn(); flash(msg); await load(); } catch (e) { setErr(e.message); } };
  if (!data) return err ? <div className="auth-error">{err}</div> : <div className="dash-empty">Loading…</div>;
  return (
    <>
      {err && <div className="auth-error">{err}</div>}
      <div className="dash-card" style={{ marginBottom: 12 }}>
        <h2>Exchange rates (EGP per 1 EUR)</h2>
        <p className="field-hint">The Central Bank of Egypt rate, entered by date. Used for Egyptian agencies' commission statements and the margin report. Nothing is fetched automatically.</p>
        <form className="cat-actions" style={{ justifyContent: "flex-start" }} onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/finance/fx-rates/${fx.day}`, "PUT", { egpPerEur: Number(fx.rate), sourceNote: "CBE" }), "Rate saved."); }}>
          <input type="date" value={fx.day} onChange={(e) => setFx({ ...fx, day: e.target.value })} required />
          <input type="number" step="0.0001" min="0" placeholder="e.g. 55.25" value={fx.rate} onChange={(e) => setFx({ ...fx, rate: e.target.value })} required />
          <button className="btn-primary sm">Save rate</button>
        </form>
        <table className="dash-table"><tbody>{data.fxRates.slice(0, 31).map((r) => (
          <tr key={r.day}><td>{dayLabel(r.day)}</td><td className="tnum">{r.egpPerEur}</td><td className="field-hint">{r.enteredBy}</td>
            <td className="row-actions"><button className="btn-ghost sm" onClick={() => run(() => call(`/admin/finance/fx-rates/${r.day}`, "DELETE"), "Rate removed.")}>Remove</button></td></tr>
        ))}</tbody></table>
      </div>
      <div className="dash-card" style={{ marginBottom: 12 }}>
        <h2>Egyptian public holidays</h2>
        <p className="field-hint">An operator advance is due 2 business days after acknowledgement: Sunday to Thursday, skipping these.</p>
        <form className="cat-actions" style={{ justifyContent: "flex-start" }} onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/finance/holidays/${hol.day}`, "PUT", { name: hol.name }).then(() => setHol({ day: "", name: "" })), "Holiday saved."); }}>
          <input type="date" value={hol.day} onChange={(e) => setHol({ ...hol, day: e.target.value })} required />
          <input value={hol.name} onChange={(e) => setHol({ ...hol, name: e.target.value })} placeholder="e.g. Armed Forces Day" required />
          <button className="btn-primary sm">Add holiday</button>
        </form>
        <table className="dash-table"><tbody>{data.holidays.map((h) => (
          <tr key={h.day}><td>{dayLabel(h.day)}</td><td>{h.name}</td>
            <td className="row-actions"><button className="btn-ghost sm" onClick={() => run(() => call(`/admin/finance/holidays/${h.day}`, "DELETE"), "Holiday removed.")}>Remove</button></td></tr>
        ))}</tbody></table>
      </div>
      <div className="dash-card" style={{ marginBottom: 12 }}>
        <h2>Penalty amounts (Operator Schedule 6)</h2>
        <p className="field-hint">In EGP. 0 until set.</p>
        <table className="dash-table"><tbody>{data.penalties.map((p) => (
          <tr key={p.code}><td>{p.label}<div className="field-hint">{p.clauseRef}{p.perTraveler ? " · per traveler" : ""}</div></td>
            <td><input type="number" min="0" step="0.01" defaultValue={p.amountEgp} style={{ width: 120 }}
              onBlur={(e) => { const v = Number(e.target.value); if (v !== p.amountEgp) run(() => call(`/admin/finance/penalties/${p.code}`, "PUT", { amountEgp: v }), "Penalty amount saved."); }} /></td></tr>
        ))}</tbody></table>
      </div>
      <div className="dash-card">
        <h2>Payment provider fees</h2>
        <p className="field-hint">For the margin report: a percentage of each charge plus a fixed amount in EUR. Until set, margins show "fee rate not set".</p>
        <form className="cat-actions" style={{ justifyContent: "flex-start" }} onSubmit={(e) => { e.preventDefault(); run(() => call("/admin/finance/fees", "PUT", { percent: Number(fees.percent), fixedEur: Number(fees.fixedEur || 0) }), "Fees saved."); }}>
          <input type="number" step="0.01" min="0" max="20" placeholder="%" value={fees.percent} onChange={(e) => setFees({ ...fees, percent: e.target.value })} required />
          <input type="number" step="0.01" min="0" placeholder="EUR fixed" value={fees.fixedEur} onChange={(e) => setFees({ ...fees, fixedEur: e.target.value })} />
          <button className="btn-primary sm">Save fees</button>
        </form>
      </div>
    </>
  );
}
