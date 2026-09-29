// The operator portal (model phase 2): assignments to acknowledge, manifests,
// the operator's own roster dates and swap requests, notices, documents and
// strikes. Operator logins only, and only with catalogue_v2 on (the server
// answers 404 otherwise). An operator sees its own entries and nothing else.
import React, { useEffect, useState } from "react";
import { ClipboardCheck, CalendarCheck, Bell, FileText, Check, Landmark } from "lucide-react";
import { apiFetch } from "./supabaseClient";
import { DashSidebar } from "./DashSidebar";
import { usePortalSection } from "./portal-section.js";
import { ManifestTable } from "./AdminOperators.jsx";
import { DOCUMENT_LABELS, STRIKE_LABELS, ACK_HOURS } from "../shared/operators.js";

const NAV_GROUPS = [{
  title: null,
  items: [
    { id: "assignments", label: "Assignments", icon: ClipboardCheck, alert: (s) => s?.toAcknowledge || 0 },
    { id: "roster", label: "Roster", icon: CalendarCheck },
    { id: "money", label: "Statements & payments", icon: Landmark },
    { id: "notices", label: "Notices", icon: Bell, alert: (s) => s?.unread || 0 },
    { id: "account", label: "Documents & strikes", icon: FileText },
  ],
}];
const SECTION_IDS = NAV_GROUPS.flatMap((g) => g.items.map((it) => it.id));
const dayLabel = (ymd) => (ymd ? new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T12:00:00Z`)) : "—");
const stamp = (iso) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "—");
const egp = (n) => (n == null ? "—" : `EGP ${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

async function call(path, method = "GET", body) {
  const r = await apiFetch(path, body === undefined ? { method } : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && path === "/operator/me") throw new Error("The operator portal isn't open yet. Sawa will tell you when it is.");
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

export function OperatorDashboard({ user, signOut, navigate }) {
  const [section, setSection] = usePortalSection(SECTION_IDS, "assignments");
  const [me, setMe] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [notices, setNotices] = useState([]);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      setErr("");
      const [m, a, n] = await Promise.all([call("/operator/me"), call("/operator/assignments"), call("/operator/notifications")]);
      setMe(m); setAssignments(a.assignments); setNotices(n.notifications || []);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(""), 4000); };

  const stats = {
    toAcknowledge: assignments.filter((a) => a.state === "offered").length,
    unread: notices.filter((n) => !n.readAt).length,
  };

  return (
    <div className="dash">
      <DashSidebar subtitle={me?.operator.legalName || "Operator"} groups={NAV_GROUPS} active={section} onSelect={setSection}
        stats={stats} roleLabel={user.role === "operator_owner" ? "Operator owner" : "Operator staff"}
        user={user} navigate={navigate} signOut={signOut} />
      <main className="dash-main">
        {notice && <div className="dash-flash" role="status">{notice}</div>}
        {err && <div className="auth-error">{err}</div>}
        {me && me.operator.status !== "active" && (
          <div className="auth-error">Your account is {me.operator.status}. {me.operator.status === "suspended" ? "You won't be rostered until Sawa has current documents." : ""}</div>
        )}
        {me && section === "assignments" && <Assignments assignments={assignments} reload={load} flash={flash} />}
        {me && section === "roster" && <Roster flash={flash} />}
        {me && section === "money" && <Money user={user} flash={flash} />}
        {me && section === "notices" && <Notices notices={notices} />}
        {me && section === "account" && <Account me={me} />}
      </main>
    </div>
  );
}

function Assignments({ assignments, reload, flash }) {
  const [openId, setOpenId] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [err, setErr] = useState("");

  async function ack(a) {
    try {
      await call(`/operator/assignments/${a.id}/acknowledge`, "POST", {});
      flash(`Acknowledged: ${a.title}, ${dayLabel(a.date)}.`);
      reload();
    } catch (e) { setErr(e.message); }
  }
  // Phase 5: an offer may be declined; it passes to the next operator in line.
  async function decline(a) {
    const reason = window.prompt(`Decline ${a.title} on ${dayLabel(a.date)}? It will be offered to another operator. It doesn't count as a strike.\n\nReason (optional):`);
    if (reason === null) return;
    try {
      await call(`/operator/assignments/${a.id}/decline`, "POST", { reason });
      flash(`Declined: ${a.title}, ${dayLabel(a.date)}.`);
      reload();
    } catch (e) { setErr(e.message); }
  }
  async function open(a) {
    setErr(""); setOpenId(a.id); setManifest(null);
    try { setManifest(await call(`/operator/departures/${a.departureId}/manifest`)); } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <div className="dash-head"><div><h1>Assignments</h1><p>Departures Sawa has given you. Acknowledge each within {ACK_HOURS} hours.</p></div></div>
      {err && <div className="auth-error">{err}</div>}
      {assignments.length ? (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>Date</th><th>Product</th><th>Spec</th><th>Seats</th><th>Expected amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td>{dayLabel(a.date)}</td>
                  <td>{a.code} {a.title}</td>
                  <td>v{a.specVersion ?? "—"}</td>
                  <td className="tnum">{a.seatsSold}</td>
                  <td className="tnum">{a.expected ? egp(a.expected.total) : "—"}{a.expected?.operatorFeePct != null && <div className="field-hint">operator fee {a.expected.operatorFeePct}% of operating cost{a.expected.feeOverride ? " (set for this departure)" : ""}</div>}{a.expected && !a.expected.frozen && <div className="field-hint">until the cut-off</div>}</td>
                  <td>
                    {a.state === "offered" && <>Due by {stamp(a.ackDueAt)}</>}
                    {a.state === "offered" && a.source === "agency" && a.candidate && <div className="field-hint">Offered to you because your agency has {a.candidate.travelers} traveler{a.candidate.travelers === 1 ? "" : "s"} on it.</div>}
                    {a.state === "declined" && <span className="tag tag-off">Declined</span>}
                    {a.state === "acknowledged" && <span className="tag tag-on">Acknowledged</span>}
                    {a.state === "expired" && <span className="tag tag-off">Not acknowledged in time</span>}
                  </td>
                  <td className="row-actions">
                    {a.state === "offered" && <button className="btn-primary sm" onClick={() => ack(a)}><Check size={14} />Acknowledge</button>}
                    {a.state === "offered" && <button className="btn-ghost sm" onClick={() => decline(a)}>Decline</button>}
                    {a.manifestAvailable && <button className="btn-ghost sm" onClick={() => open(a)}>Manifest</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="dash-empty">No assignments yet.</div>}
      {openId && manifest && (
        <div className="dash-card" style={{ marginTop: 12 }}>
          <h2>{manifest.departure.code} {manifest.departure.title}, {dayLabel(manifest.departure.date)}</h2>
          <p className="field-hint">{manifest.frozen ? `Frozen at the cut-off (${stamp(manifest.frozenAt)}).` : "Live: this changes until the cut-off."} {manifest.seatCount} travelers.</p>
          <ManifestTable travelers={manifest.travelers} />
        </div>
      )}
    </>
  );
}

function Roster({ flash }) {
  const [entries, setEntries] = useState(null);
  const [swaps, setSwaps] = useState([]);
  const [swapFor, setSwapFor] = useState(null);
  const [targets, setTargets] = useState([]);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    try {
      const [r, s] = await Promise.all([call("/operator/roster"), call("/operator/swaps")]);
      setEntries(r.entries); setSwaps(s.swaps);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function startSwap(e) {
    setSwapFor(e); setTo(""); setNote("");
    try { setTargets((await call(`/operator/swap-targets?entryId=${e.id}`)).operators); } catch (e2) { setErr(e2.message); }
  }
  async function submit(ev) {
    ev.preventDefault();
    try {
      await call("/operator/swaps", "POST", { entryId: swapFor.id, toOperatorId: Number(to), note: note || null });
      flash("Swap requested. Sawa approves or rejects it.");
      setSwapFor(null); load();
    } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <div className="dash-head"><div><h1>Roster</h1><p>Your dates from published rosters. A swap needs Sawa's approval.</p></div></div>
      {err && <div className="auth-error">{err}</div>}
      {entries && (entries.length ? (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>Date</th><th>Product</th><th></th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{dayLabel(e.date)}</td><td>{e.title || e.productId}</td>
                  <td className="row-actions"><button className="btn-ghost sm" onClick={() => startSwap(e)}>Request swap</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="dash-empty">No rostered dates yet.</div>)}
      {swapFor && (
        <form className="dash-card" style={{ marginTop: 12 }} onSubmit={submit}>
          <h2>Swap {dayLabel(swapFor.date)}</h2>
          <div className="form-grid">
            <label className="field"><span>To</span>
              <select value={to} onChange={(e) => setTo(e.target.value)} required>
                <option value="">Choose an operator</option>
                {targets.map((o) => <option key={o.id} value={o.id}>{o.legalName}</option>)}
              </select>
            </label>
            <label className="field"><span>Note</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
          </div>
          <div className="cat-actions">
            <button type="button" className="btn-ghost" onClick={() => setSwapFor(null)}>Cancel</button>
            <button className="btn-primary" disabled={!to}>Request</button>
          </div>
        </form>
      )}
      {swaps.length > 0 && (
        <div className="dash-card" style={{ marginTop: 12 }}>
          <h2>Your swap requests</h2>
          <ul>{swaps.map((s) => <li key={s.id}>{dayLabel(s.date)} {s.title} → {s.toName}: {s.state}</li>)}</ul>
        </div>
      )}
    </>
  );
}

function Notices({ notices }) {
  return (
    <>
      <div className="dash-head"><div><h1>Notices</h1><p>Assignments, reminders and changes from Sawa. The same notices go to your email.</p></div></div>
      {notices.length ? (
        <div className="dash-card">
          {notices.map((n) => (
            <div key={n.id} style={{ marginBottom: 12 }}>
              <strong>{n.title}</strong> <span className="field-hint">{stamp(n.createdAt)}</span>
              <p style={{ whiteSpace: "pre-line", margin: "4px 0 0" }}>{n.body}</p>
            </div>
          ))}
        </div>
      ) : <div className="dash-empty">No notices.</div>}
    </>
  );
}

function Account({ me }) {
  return (
    <>
      <div className="dash-head"><div><h1>Documents &amp; strikes</h1><p>Send renewals to Sawa before they expire; an expired document suspends you from the roster.</p></div></div>
      <div className="dash-card" style={{ marginBottom: 12 }}>
        <h2>Documents</h2>
        <ul>
          {Object.keys(DOCUMENT_LABELS).map((kind) => {
            const d = me.documents.find((x) => x.kind === kind);
            const gap = me.documentGaps.find((g) => g.kind === kind);
            return <li key={kind}>{DOCUMENT_LABELS[kind]}: {d ? `expires ${dayLabel(d.expiresOn)}` : "not on file"}{gap && <span className="tag tag-warn" style={{ marginLeft: 6 }}>{gap.problem}</span>}</li>;
          })}
        </ul>
      </div>
      <div className="dash-card">
        <h2>Strikes in the last 90 days: {me.strikes90}</h2>
        {me.strikes.length ? <ul>{me.strikes.map((s, i) => <li key={i}>{stamp(s.createdAt)} · {STRIKE_LABELS[s.kind]}{s.note ? `: ${s.note}` : ""}</li>)}</ul> : <p className="field-hint">None.</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- phase 3
const PAYABLE_LABEL = { advance: "Advance (50%)", balance: "Balance" };
function Money({ user, flash }) {
  const [data, setData] = useState(null);
  const [bank, setBank] = useState(null);
  const [form, setForm] = useState(null);
  const [disputing, setDisputing] = useState(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  async function load() {
    try {
      setErr("");
      const [s, b] = await Promise.all([call("/operator/statements"), call("/operator/bank")]);
      setData(s); setBank(b.accounts);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  const run = async (fn, msg) => { setErr(""); try { await fn(); flash(msg); await load(); } catch (e) { setErr(e.message); } };
  const pdf = (id) => apiFetch(`/operator/statements/${id}.pdf`).then((r) => r.blob()).then((b) => window.open(URL.createObjectURL(b), "_blank", "noopener"));
  return (
    <>
      <div className="dash-head"><div><h1>Statements &amp; payments</h1><p>In EGP, from the rate card version locked for each departure. Sawa pays the advance 2 business days after you acknowledge, and the balance 7 days after the departure ends.</p></div></div>
      {err && <div className="auth-error">{err}</div>}
      {data && (
        <>
          <div className="dash-card" style={{ marginBottom: 12 }}>
            <h2>Payments</h2>
            {data.payables.length ? (
              <table className="dash-table"><tbody>{data.payables.map((p) => (
                <tr key={p.id}><td>{PAYABLE_LABEL[p.kind]}<div className="field-hint">departure #{p.departureId}</div></td>
                  <td className="tnum">{egp(p.amount)}{p.setoffEgp > 0 && <div className="field-hint">less {egp(p.setoffEgp)} set off (clause 9.4): {egp(p.netDue)}</div>}</td>
                  <td>due {dayLabel(p.dueOn)}</td><td>{p.state === "paid" ? <span className="tag tag-on">Paid</span> : p.state === "offset" ? <span className="tag tag-on">Set off</span> : p.state === "on_hold" ? <span className="tag tag-warn">On hold</span> : "Due"}</td></tr>
              ))}</tbody></table>
            ) : <p className="field-hint">Nothing yet.</p>}
          </div>
          {data.receivables?.some((r) => r.state === "open") && (
            <div className="dash-card" style={{ marginBottom: 12 }}>
              <h2>Owed to Sawa</h2>
              <p className="field-hint">Taken from your next advance or balance (clause 9.4), unless you repay it by transfer first.</p>
              <table className="dash-table"><tbody>{data.receivables.filter((r) => r.state === "open").map((r) => (
                <tr key={r.id}><td>{r.reason}</td><td className="tnum">{egp(r.outstandingEgp)}</td></tr>
              ))}</tbody></table>
            </div>
          )}
          <div className="dash-card" style={{ marginBottom: 12 }}>
            <h2>Settlement statements</h2>
            {data.statements.length ? (
              <table className="dash-table"><tbody>{data.statements.map((st) => (
                <tr key={st.id}>
                  <td>{st.snapshot?.departure?.code} {st.snapshot?.departure?.title}<div className="field-hint">{dayLabel(st.snapshot?.departure?.date)}</div>
                    {/* Phase 5: paid twice, kept apart — this is the operator side. */}
                    {st.snapshot?.distribution?.ownAgencyShare && <div className="field-hint">{st.snapshot.distribution.ownAgencyShare.note}</div>}</td>
                  <td className="tnum">{egp(st.snapshot?.balance)}</td>
                  <td>{st.state}{st.autoAcceptOn && <div className="field-hint">accepted automatically on {stamp(st.autoAcceptOn)} unless disputed</div>}
                    {st.disputeReason && <div className="field-hint">Your dispute: {st.disputeReason}</div>}
                    {st.resolutionNote && <div className="field-hint">Sawa: {st.resolutionNote}</div>}</td>
                  <td className="row-actions">
                    <button className="btn-ghost sm" onClick={() => pdf(st.departureId)}>PDF</button>
                    {st.state === "sent" && <button className="btn-ghost sm" onClick={() => { setDisputing(st); setReason(""); }}>Dispute</button>}
                  </td>
                </tr>
              ))}</tbody></table>
            ) : <p className="field-hint">No statements yet.</p>}
            {disputing && (
              <form onSubmit={(e) => { e.preventDefault(); run(() => call(`/operator/statements/${disputing.departureId}/dispute`, "POST", { reason }).then(() => setDisputing(null)), "Dispute sent to Sawa."); }}>
                <label className="field field-full"><span>What is wrong with this statement?</span><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} /></label>
                <div className="cat-actions"><button type="button" className="btn-ghost" onClick={() => setDisputing(null)}>Cancel</button><button className="btn-primary">Send dispute</button></div>
              </form>
            )}
          </div>
        </>
      )}
      {bank && (
        <div className="dash-card">
          <h2>Bank details</h2>
          <p className="field-hint">The account holder must be your company's legal name. A change is used only after Sawa verifies it, and both you and Sawa are emailed.</p>
          {bank.length ? <table className="dash-table"><tbody>{bank.map((a) => (
            <tr key={a.id}><td>{a.holderName}<div className="field-hint">{a.bankName}</div></td><td>{a.iban || a.accountNumber}</td><td>{a.state}</td></tr>
          ))}</tbody></table> : <p className="field-hint">No bank details yet.</p>}
          {user.role === "operator_owner" && (form ? (
            <form onSubmit={(e) => { e.preventDefault(); run(() => call("/operator/bank", "POST", form).then(() => setForm(null)), "Saved. Sawa verifies the change before using it."); }}>
              <div className="form-grid">
                <label className="field"><span>Account holder</span><input value={form.holderName} onChange={(e) => setForm({ ...form, holderName: e.target.value })} required /></label>
                <label className="field"><span>Bank</span><input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} required /></label>
                <label className="field"><span>Account number</span><input value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} /></label>
                <label className="field"><span>IBAN</span><input value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} /></label>
                <label className="field"><span>SWIFT (if relevant)</span><input value={form.swift} onChange={(e) => setForm({ ...form, swift: e.target.value })} /></label>
              </div>
              <div className="cat-actions"><button type="button" className="btn-ghost" onClick={() => setForm(null)}>Cancel</button><button className="btn-primary">Save</button></div>
            </form>
          ) : <button className="btn-ghost sm" onClick={() => setForm({ holderName: "", bankName: "", accountNumber: "", iban: "", swift: "" })}>Change bank details</button>)}
        </div>
      )}
    </>
  );
}
