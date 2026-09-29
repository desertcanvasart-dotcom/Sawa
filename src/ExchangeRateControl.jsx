// Phase 7: the exchange rate, one site-wide setting, automatic or manual.
// The same control in Finance → Rates and settings and in section 3 of every
// rate card editor: changing it anywhere changes it for every tour (a rate per
// tour is how 43 and 97 got typed in). From a rate card it asks first.
import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { apiFetch } from "./supabaseClient";

export const RATE_LABEL = "Exchange rate (EGP per 1 EUR)";
export const RATE_HELP = "Not a price. Used to convert the euro price into EGP for operator and agency calculations.";
export const ALL_TOURS_CONFIRM = "This changes the exchange rate for all tours. Continue?";

async function put(body) {
  const r = await apiFetch("/admin/finance/exchange-rate", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

// "59.0, automatic": the rate as the editor quotes it beside an amount.
export const rateTag = (x) => (x?.rate == null ? null : `${Number(x.rate).toFixed(Math.max(1, (String(x.rate).split(".")[1] || "").length))}, ${x.mode}`);

// `summary` is GET /admin/finance/exchange-rate. `fromRateCard` asks before
// saving. `onChanged(summary)` after a save.
export function ExchangeRateControl({ summary, onChanged, fromRateCard = false, flash }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ mode: summary?.mode || "automatic", rate: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (summary === undefined) return <div className="field"><span>{RATE_LABEL}</span><strong>…</strong></div>;
  const s = summary || { mode: "automatic", rate: null, market: null };

  async function save(e) {
    e.preventDefault();
    if (fromRateCard && !window.confirm(ALL_TOURS_CONFIRM)) return;
    setBusy(true); setErr("");
    try {
      const out = await put({ mode: f.mode, egpPerEur: f.mode === "manual" ? Number(f.rate) : undefined, reason: f.reason });
      setEditing(false);
      setF({ mode: out.summary.mode, rate: "", reason: "" });
      flash?.(f.mode === "manual" ? "Manual exchange rate saved for all tours. It is logged with your reason." : "Automatic exchange rate restored for all tours.");
      onChanged?.(out.summary);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="field fx-control">
      <span>{RATE_LABEL} · site-wide</span>
      <div className="fx-value">
        <strong className={`tnum${s.rate == null ? " fx-unset" : ""}`}>{s.rate == null ? "Exchange rate not set" : `${s.rate} (${s.mode})`}</strong>
        <span className="field-hint">{RATE_HELP}</span>
        {s.mode === "automatic" && s.rate != null && <span className="field-hint">The latest approved market rate less {s.bufferPct}%, renewed weekly or when the market moves more than 3%.</span>}
      </div>
      {s.market && <span className="fx-market tnum">Market today: <b>{s.market.egpPerEur}</b>{s.rate != null ? <> · You're using: <b>{s.rate}</b></> : ""}</span>}
      {s.gapWarning && <span className="auth-error" role="status"><AlertTriangle size={14} /> The manual rate is {s.gapPct}% from the market rate.</span>}
      {!editing ? (
        <button type="button" className="btn-ghost sm fx-change" onClick={() => { setF({ mode: s.mode, rate: s.mode === "manual" && s.rate != null ? String(s.rate) : "", reason: "" }); setEditing(true); }}>Change exchange rate</button>
      ) : (
        <div className="fx-edit" role="group" aria-label="Change the exchange rate for all tours">
          <label><input type="radio" name="fx-mode" checked={f.mode === "automatic"} onChange={() => setF({ ...f, mode: "automatic" })} /> Automatic (market rate less {s.bufferPct ?? 3}%)</label>
          <label><input type="radio" name="fx-mode" checked={f.mode === "manual"} onChange={() => setF({ ...f, mode: "manual" })} /> Manual (used exactly as entered, no buffer)</label>
          {f.mode === "manual" && <input className="re-num" type="number" min="0" step="0.0001" placeholder="EGP per 1 EUR, e.g. 58.00" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />}
          <input placeholder={f.mode === "manual" ? "Reason (required, logged)" : "Reason (optional, logged)"} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          {err && <span className="auth-error">{err}</span>}
          <div className="cat-actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="btn-primary sm" disabled={busy || (f.mode === "manual" && (!f.rate || !f.reason.trim()))} onClick={save}>Save for all tours</button>
            <button type="button" className="btn-ghost sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
