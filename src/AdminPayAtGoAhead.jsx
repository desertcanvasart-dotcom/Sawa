// Admin → Finance, model phase 4: pay at GoAhead (the ops tasks while Tab is
// manual, each departure's seats as paid / awaiting / released, deadline
// extensions, cancellations with the fee under the booking's tiers) and the
// cancellation-tier editor with its loss check (clause 10.2).
import React, { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { apiFetch } from "./supabaseClient";
import { TYPE_LABELS } from "../shared/catalogue.js";
const eur = (n) => (n == null ? "—" : `€${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (iso) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " Cairo" : "—");
const dayLabel = (ymd) => (ymd ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T12:00:00Z`)) : "—");
const TONE = { paid: "tag-on", due: "tag-warn", released: "tag-off", cancelled: "", not_requested: "" };

async function call(path, method = "GET", body) {
  const r = await apiFetch(path, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

// ---------------------------------------------------------------- pay at GoAhead
export function PayAtGoAhead({ flash, isSuperAdmin }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [inputs, setInputs] = useState({});
  const [cancel, setCancel] = useState(null);
  const [extend, setExtend] = useState(null);
  const set = (k, v) => setInputs((x) => ({ ...x, [k]: v }));
  const load = () => call("/admin/pay-at-goahead").then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn, msg) => { setErr(""); try { await fn(); flash(msg); await load(); } catch (e) { setErr(e.message); } };

  if (!data) return err ? <div className="auth-error">{err}</div> : <div className="dash-empty">Loading…</div>;
  return (
    <>
      {err && <div className="auth-error">{err}</div>}
      <p className="field-hint">
        Catalog bookings pay the full price after GoAhead, within {data.settings.windowHours} hours of the link (never after the cut-off). Unpaid seats are
        released at the deadline and offered to the waitlist (held {data.settings.offerHours} hours). Tab is used by hand: make each link with the
        booking code as its reference, and mark payments with Tab's reference.
      </p>
      <div className="dash-card" style={{ marginBottom: 12 }}>
        <h2>To do in Tab ({data.tasks.length})</h2>
        {data.tasks.length ? (
          <table className="dash-table"><tbody>{data.tasks.map((t) => (
            <tr key={t.id}>
              <td>{t.title}<div className="field-hint">{when(t.createdAt)}</div></td>
              <td style={{ minWidth: 280 }}>
                {t.kind === "create_link" ? (
                  <form className="cat-actions" onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/pay-requests/${t.requestId}/link`, "POST", { linkUrl: inputs[`l${t.id}`] }), "Link sent; the deadline has started."); }}>
                    <input aria-label="Tab link" placeholder="https://… (the Tab link)" value={inputs[`l${t.id}`] || ""} onChange={(e) => set(`l${t.id}`, e.target.value)} />
                    <button className="btn-primary sm">Send link</button>
                  </form>
                ) : (
                  <form className="cat-actions" onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/refunds/${t.refundId}/done`, "POST", { providerReference: inputs[`r${t.id}`] }), "Refund recorded."); }}>
                    <input aria-label="Tab refund reference" placeholder="Tab's refund reference" value={inputs[`r${t.id}`] || ""} onChange={(e) => set(`r${t.id}`, e.target.value)} />
                    <button className="btn-primary sm">Refund made</button>
                  </form>
                )}
              </td>
            </tr>
          ))}</tbody></table>
        ) : <div className="dash-empty">Nothing to do.</div>}
      </div>

      {data.departures.length ? data.departures.map((d) => (
        <div className="dash-card" key={d.id} style={{ marginBottom: 12 }}>
          <h2>{d.code} {d.title} · {dayLabel(d.date)}</h2>
          <p className="field-hint">
            {d.status === "go_ahead" ? "Going ahead" : "Not at GoAhead yet"} · cut-off {when(d.cutoffAt)} · paid {d.counts.paid} · awaiting {d.counts.awaiting}
            {" "}· released {d.counts.released}{d.counts.shortWindow ? <> · <span className="tag tag-warn">short window: {d.counts.shortWindow}</span></> : null}
          </p>
          <div className="table-wrap">
            <table className="dash-table">
              <thead><tr><th>Booking</th><th>Seats</th><th>Amount</th><th>Payment</th><th /></tr></thead>
              <tbody>{d.seats.map((s) => {
                const r = s.request;
                return (
                  <tr key={s.pledgeId}>
                    <td>{s.bookingCode || s.pledgeId.slice(-8)} · {s.name}{s.agency ? <div className="field-hint">Agency {s.agency}{r?.payer === "agency" ? " (billed)" : ""}</div> : null}</td>
                    <td className="tnum">{s.seats}</td>
                    <td className="tnum">{eur(s.amountEur)}</td>
                    <td>
                      <span className={`tag ${TONE[s.standing] || ""}`}>{s.status === "cancelled" && s.standing !== "released" ? "Canceled" : s.label}</span>
                      {r?.state === "sent" && <div className="field-hint">due {when(r.dueAt)}{r.extendedAt ? ` (extended; first ${when(r.originalDueAt)})` : ""}</div>}
                      {r?.state === "paid" && <div className="field-hint">ref {r.providerReference}</div>}
                    </td>
                    <td style={{ minWidth: 260 }}>
                      {r && ["sent", "awaiting_link"].includes(r.state) && s.status !== "cancelled" && (
                        <form className="cat-actions" onSubmit={(e) => { e.preventDefault(); run(() => call(`/admin/pay-requests/${r.id}/paid`, "POST", { providerReference: inputs[`p${r.id}`] }), "Marked paid."); }}>
                          <input aria-label="Tab payment reference" placeholder="Tab reference" value={inputs[`p${r.id}`] || ""} onChange={(e) => set(`p${r.id}`, e.target.value)} />
                          <button className="btn-ghost sm">Mark paid</button>
                        </form>
                      )}
                      {r?.state === "sent" && s.status !== "cancelled" && <button className="btn-ghost sm" onClick={() => setExtend({ request: r, dueAt: "", reason: "" })}>Extend</button>}
                      {s.status !== "cancelled" && d.status === "go_ahead" && (
                        <button className="btn-ghost sm" onClick={() => call(`/admin/pay-at-goahead/bookings/${encodeURIComponent(s.pledgeId)}/cancellation-quote`).then((q) => setCancel({ seat: s, quote: q.quote, reason: "traveler" })).catch((e) => setErr(e.message))}>Cancel…</button>
                      )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      )) : <div className="dash-empty">No catalog bookings on pay at GoAhead yet.</div>}

      {data.refunds.length > 0 && (
        <div className="dash-card" style={{ marginBottom: 12 }}>
          <h2>Refunds</h2>
          <table className="dash-table">
            <thead><tr><th>Booking</th><th>Kind</th><th>Paid</th><th>Kept</th><th>Refund</th><th>Status</th></tr></thead>
            <tbody>{data.refunds.map((f) => (
              <tr key={f.id}>
                <td>{f.pledgeId.slice(-8)}</td>
                <td>{f.kind === "resale" ? "Fee returned (seat resold)" : `Cancellation (${f.retainedPct}% kept)`}</td>
                <td className="tnum">{eur(f.paidEur)}</td><td className="tnum">{eur(f.feeRetainedEur)}</td><td className="tnum">{eur(f.amountEur)}</td>
                <td>{f.state === "done" ? <span className="tag tag-on">Done · {f.providerReference}</span> : <span className="tag tag-warn">To refund in Tab</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {isSuperAdmin && <PaySettings settings={data.settings} onSave={(v) => run(() => call("/admin/pay-at-goahead/settings", "PUT", v), "Saved.")} />}

      {extend && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Extend the deadline" onClick={() => setExtend(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); run(async () => { await call(`/admin/pay-requests/${extend.request.id}/extend`, "POST", { dueAt: new Date(extend.dueAt).toISOString(), reason: extend.reason }); setExtend(null); }, "Deadline extended."); }}>
            <h2>Extend the deadline</h2>
            <p className="field-hint">Now due {when(extend.request.dueAt)}. The first deadline is kept on record. The new one can't be after the cut-off.</p>
            <label className="field"><span>New deadline (your local time)</span><input type="datetime-local" required value={extend.dueAt} onChange={(e) => setExtend({ ...extend, dueAt: e.target.value })} /></label>
            <label className="field"><span>Reason</span><input required value={extend.reason} onChange={(e) => setExtend({ ...extend, reason: e.target.value })} /></label>
            <div className="cat-actions"><button type="button" className="btn-ghost sm" onClick={() => setExtend(null)}>Close</button><button className="btn-primary sm">Extend</button></div>
          </form>
        </div>
      )}
      {cancel && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Cancel the booking" onClick={() => setCancel(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); run(async () => { await call(`/admin/pay-at-goahead/bookings/${encodeURIComponent(cancel.seat.pledgeId)}/cancel`, "POST", { reason: cancel.reason }); setCancel(null); }, "Canceled."); }}>
            <h2>Cancel {cancel.seat.bookingCode}</h2>
            {cancel.quote.paymentState === "paid" ? (
              <p>Under cancellation terms v{cancel.quote.tierVersion} ({cancel.quote.hoursBefore} hours before the start), Sawa keeps <b>{cancel.quote.retainedPct}%</b> of the {eur(cancel.quote.priceEur)} price:
                {" "}<b>{eur(cancel.quote.fee)}</b>. Refund <b>{eur(cancel.quote.refund)}</b> of {eur(cancel.quote.paid)} paid (a task to refund it in Tab). If a waitlisted traveler takes the seat before the cut-off, the fee is returned too.</p>
            ) : <p>Nothing has been paid on this booking: nothing is kept or refunded.</p>}
            <label className="field"><span>Who asked</span>
              <select value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })}>
                <option value="traveler">The traveler</option><option value="admin">Sawa</option>
              </select>
            </label>
            <div className="cat-actions"><button type="button" className="btn-ghost sm" onClick={() => setCancel(null)}>Close</button><button className="btn-primary sm">Cancel the booking</button></div>
          </form>
        </div>
      )}
    </>
  );
}

function PaySettings({ settings, onSave }) {
  const [v, setV] = useState(settings);
  return (
    <form className="dash-card form-grid" onSubmit={(e) => { e.preventDefault(); onSave({ windowHours: Number(v.windowHours), offerHours: Number(v.offerHours) }); }}>
      <h2 style={{ gridColumn: "1 / -1" }}>Settings</h2>
      <label className="field"><span>Payment window</span>
        <select value={v.windowHours} onChange={(e) => setV({ ...v, windowHours: e.target.value })}><option value={48}>48 hours</option><option value={24}>24 hours</option></select>
      </label>
      <label className="field"><span>Waitlist offer held (hours)</span><input type="number" min={1} max={72} value={v.offerHours} onChange={(e) => setV({ ...v, offerHours: e.target.value })} /></label>
      <div className="cat-actions"><button className="btn-primary sm">Save</button></div>
    </form>
  );
}

// ---------------------------------------------------------------- tiers
export function CancellationTiers({ flash, isSuperAdmin }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState(null);
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 10));
  const [loss, setLoss] = useState(null);
  const load = async () => {
    try {
      const d = await call("/admin/cancellation-tiers");
      setData(d);
      const draft = d.versions.find((v) => v.state === "draft");
      setRows(draft ? draft.rows.map((t) => ({ ...t, amount: t.unit === "days" ? t.minBeforeHours / 24 : t.minBeforeHours })) : null);
      const focus = draft || d.versions.find((v) => v.id === d.inForceId);
      if (focus) setLoss(await call(`/admin/cancellation-tiers/${focus.id}/loss-check`));
      setErr("");
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);
  const run = async (fn, msg) => { setErr(""); try { await fn(); flash(msg); await load(); } catch (e) { setErr(e.message); } };
  if (!data) return err ? <div className="auth-error">{err}</div> : <div className="dash-empty">Loading…</div>;
  const draft = data.versions.find((v) => v.state === "draft");
  const inForce = data.versions.find((v) => v.id === data.inForceId);
  const edit = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
      {err && <div className="auth-error">{err}</div>}
      <p className="field-hint">
        What Sawa keeps when a traveler cancels after GoAhead: a percentage of the full price, by how long before the start. A booking keeps the version in
        force when it was made (for an agency booking, when the agency booked). A published version never changes; a change is a new version from its date.
      </p>
      {loss && loss.warnings > 0 && (
        <div className="auth-error" role="status"><AlertTriangle size={14} /> Version {loss.version.version}: on {loss.warnings} product{loss.warnings === 1 ? "" : "s"}, a cancellation after the cut-off (or GoAhead deadline) keeps less than Sawa still owes the operator for the seat (clause 10.2).</div>
      )}
      {inForce && (
        <div className="dash-card" style={{ marginBottom: 12 }}>
          <h2>In force: version {inForce.version}, from {dayLabel(inForce.effectiveFrom)}</h2>
          <TierTable rows={inForce.rows} />
        </div>
      )}
      {draft ? (
        <div className="dash-card" style={{ marginBottom: 12 }}>
          <h2>Draft: version {draft.version}</h2>
          {Object.keys(TYPE_LABELS).map((type) => (
            <div key={type} style={{ marginBottom: 8 }}>
              <b>{TYPE_LABELS[type]}</b>
              {rows.map((r, i) => r.productType === type && (
                <div className="cat-actions" key={i} style={{ justifyContent: "flex-start" }}>
                  <span>From</span>
                  <input type="number" min={0} style={{ width: 80 }} aria-label="Time before the start" value={r.amount} onChange={(e) => edit(i, { amount: e.target.value })} />
                  <select aria-label="Unit" value={r.unit} onChange={(e) => edit(i, { unit: e.target.value })}><option value="hours">hours</option><option value="days">days</option></select>
                  <span>before the start, keep</span>
                  <input type="number" min={0} max={100} step="0.5" style={{ width: 80 }} aria-label="Retained percentage" value={r.retainedPct} onChange={(e) => edit(i, { retainedPct: e.target.value })} />
                  <span>%</span>
                  <button type="button" className="btn-ghost sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn-ghost sm" onClick={() => setRows([...rows, { productType: type, amount: 0, unit: "hours", retainedPct: 0 }])}>Add a tier</button>
            </div>
          ))}
          <p className="field-hint">The last tier of each type starts at 0 (up to the start, and no-shows).</p>
          <div className="cat-actions">
            <button className="btn-ghost sm" onClick={() => run(() => call(`/admin/cancellation-tiers/${draft.id}`, "DELETE"), "Draft discarded.")}>Discard</button>
            <button className="btn-primary sm" onClick={() => run(() => call(`/admin/cancellation-tiers/${draft.id}`, "PUT", {
              rows: rows.map((r) => ({ productType: r.productType, amount: Number(r.amount), unit: r.unit, retainedPct: Number(r.retainedPct) })),
            }), "Draft saved.")}>Save draft</button>
            {isSuperAdmin && (
              <>
                <input type="date" aria-label="Effective from" value={effective} onChange={(e) => setEffective(e.target.value)} />
                <button className="btn-primary sm" onClick={() => run(() => call(`/admin/cancellation-tiers/${draft.id}/publish`, "POST", { effectiveFrom: effective }), "Published.")}>Publish</button>
              </>
            )}
          </div>
        </div>
      ) : <button className="btn-primary sm" onClick={() => run(() => call("/admin/cancellation-tiers/draft", "POST", {}), "Draft started from the version in force.")}>Change the tiers</button>}

      {loss && (
        <div className="dash-card" style={{ marginBottom: 12 }}>
          <h2>Loss check, version {loss.version.version}</h2>
          <p className="field-hint">
            For each window after the cut-off (day and one-way tours) or the GoAhead deadline (cruises, multi-day): the fee kept on the published price
            against what Sawa still owes the operator for that seat under the rate in force, at {loss.fx ? `${loss.fx.egpPerEur} EGP/EUR (${dayLabel(loss.fx.day)})` : "no exchange rate yet"}.
          </p>
          <table className="dash-table">
            <thead><tr><th>Product</th><th>Window</th><th>Kept</th><th>Owed to the operator</th><th /></tr></thead>
            <tbody>{loss.products.flatMap((p) => p.windows.filter((w) => w.afterPoint).map((w) => (
              <tr key={`${p.product.id}-${w.minBeforeHours}`}>
                <td>{p.product.code} {p.product.title}<div className="field-hint">{p.product.typeLabel} · {eur(p.retailEur)}</div></td>
                <td>{w.window}<div className="field-hint">{w.retainedPct}% kept</div></td>
                <td className="tnum">{eur(w.retainedEur)}</td>
                <td className="tnum">{eur(w.owedEur)}</td>
                <td>{w.problem ? <span className="tag tag-warn">{w.problem}</span> : w.losesMoney ? <span className="tag tag-off">Loses {eur(w.lossEur)} a seat</span> : <span className="tag tag-on">Covered</span>}</td>
              </tr>
            )))}</tbody>
          </table>
        </div>
      )}
      <details><summary>All versions</summary>
        {data.versions.map((v) => <div key={v.id} className="field-hint">v{v.version} · {v.state}{v.effectiveFrom ? ` from ${dayLabel(v.effectiveFrom)}` : ""}{v.id === data.inForceId ? " · in force" : ""}{v.publishedBy ? ` · ${v.publishedBy}` : ""}</div>)}
      </details>
    </>
  );
}

function TierTable({ rows }) {
  const byType = Object.keys(TYPE_LABELS).map((type) => [type, rows.filter((r) => r.productType === type).sort((a, b) => b.minBeforeHours - a.minBeforeHours)]);
  const amount = (r) => (r.unit === "days" ? `${r.minBeforeHours / 24} days` : `${r.minBeforeHours} hours`);
  return (
    <table className="dash-table"><tbody>{byType.map(([type, list]) => (
      <tr key={type}><td>{TYPE_LABELS[type]}</td><td>{list.map((r) => `${r.minBeforeHours ? `from ${amount(r)}` : "under that, and no-shows"}: ${r.retainedPct}%`).join(" · ")}</td></tr>
    ))}</tbody></table>
  );
}

// The margin report's warning, per departure.
export function LossWarnings({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div className="field-hint">{warnings.map((w, i) => (
      <div key={i}><span className="tag tag-off">Loss</span> v{w.tierVersion} {w.window}: keeps {eur(w.retainedEur)}, owes {eur(w.owedEur)}</div>
    ))}</div>
  );
}
