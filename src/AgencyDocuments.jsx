// Agency → Documents (068): the company's papers and bank details, sent from
// the agency's own dashboard. Each one waits for Sawa to review it (Admin →
// Operators → the company); the approved one stays in force until a new one is
// approved. The owner sends; agents see the status.
import React, { useEffect, useState } from "react";
import { Upload, FileText } from "lucide-react";
import { apiFetch } from "./supabaseClient";
import { DOCUMENT_KINDS, DOCUMENT_LABELS } from "../shared/operators.js";
import { fmtDate } from "./dates.js";

async function call(path, method = "GET", body) {
  const r = await apiFetch(path, body === undefined ? { method } : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

const readFile = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(new Error("Couldn't read that file."));
  fr.readAsDataURL(file);
});
const MAX_FILE_MB = 8;
const today = () => new Date().toISOString().slice(0, 10);

// Where a paper stands, for the agency: the approved one (or none), and what
// was sent since.
function docStatus(kind, docs) {
  const approved = docs.find((d) => d.kind === kind && d.reviewState === "approved" && !d.supersededAt);
  const waiting = docs.find((d) => d.kind === kind && d.reviewState === "pending" && !d.supersededAt);
  const rejected = docs.filter((d) => d.kind === kind && d.reviewState === "rejected")
    .sort((a, b) => String(b.reviewedAt || "").localeCompare(String(a.reviewedAt || "")))[0];
  // A rejection only matters until something newer was sent or approved.
  const newer = (x) => x && rejected && String(x.uploadedAt) > String(rejected.uploadedAt);
  return { approved, waiting, rejected: rejected && !newer(waiting) && !newer(approved) ? rejected : null };
}

export function AgencyDocuments({ isOwner, agencyName }) {
  const [data, setData] = useState(null);
  const [bank, setBank] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const [bankForm, setBankForm] = useState(null);

  async function load() {
    try {
      setErr("");
      const [d, b] = await Promise.all([call("/agency/documents"), call("/agency/bank")]);
      setData(d); setBank(b.accounts || []);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  const run = async (fn, done) => {
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); setMsg(done); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const openFile = (doc) => call(`/agency/documents/${doc.id}/file`).then((j) => window.open(j.url, "_blank", "noopener")).catch((e) => setErr(e.message));

  async function send(e) {
    e.preventDefault();
    if (!form.file) { setErr("Attach the document (PDF or photo)."); return; }
    if (form.file.size > MAX_FILE_MB * 1024 * 1024) { setErr(`That file is over ${MAX_FILE_MB} MB. Send a smaller scan or photo.`); return; }
    await run(async () => {
      const dataUrl = await readFile(form.file);
      await call("/agency/documents", "POST", { kind: form.kind, number: form.number || null, expiresOn: form.expiresOn, filename: form.file.name, dataUrl });
      setForm(null);
    }, `${DOCUMENT_LABELS[form.kind]} sent. Sawa will review it.`);
  }

  const legalName = data?.operator?.legalName || agencyName || "";
  const verified = (bank || []).find((a) => a.state === "verified");
  const pendingBank = (bank || []).find((a) => a.state === "pending");
  const rejectedBank = (bank || []).filter((a) => a.state === "rejected")[0];

  return (
    <>
      <div className="dash-head"><div><h1>Documents</h1>
        <p>Your company's papers and bank details. Sawa reviews each one before it counts; keep them current so you can run departures.</p></div></div>
      {err && <div className="auth-error" role="alert">{err}</div>}
      {msg && <div className="dash-flash" role="status">{msg}</div>}
      {!data ? (!err && <div className="dash-empty">Loading…</div>) : (
        <div className="agency-docs">
          <div className="dash-card">
            <h2>Company papers</h2>
            <p className="field-hint">
              No ETAA paper is needed: every company with a Ministry of Tourism license is an ETAA member.
              {data.operator?.status === "active" && " Your company is active with Sawa."}
              {data.operator?.activationException && " Sawa has activated your company while some papers are outstanding; please send them."}
            </p>
            {!isOwner && <p className="field-hint">Only your agency's owner can send documents.</p>}
            <table className="dash-table"><tbody>
              {DOCUMENT_KINDS.map((kind) => {
                const st = docStatus(kind, data.documents);
                const expired = st.approved && st.approved.expiresOn < today();
                return (
                  <tr key={kind}>
                    <td><strong>{DOCUMENT_LABELS[kind]}</strong>
                      {st.approved && <div className="field-hint">{st.approved.number ? `No. ${st.approved.number} · ` : ""}expires {fmtDate(st.approved.expiresOn)}</div>}
                      {st.rejected && <div className="field-hint doc-rejected">Not accepted: {st.rejected.reviewNote}</div>}</td>
                    <td>
                      {st.approved && !expired && <span className="tag tag-on">Approved</span>}
                      {expired && <span className="tag tag-off">Expired</span>}
                      {st.waiting && <span className="tag tag-warn">Sent, waiting for review</span>}
                      {!st.approved && !st.waiting && <span className="tag tag-off">{st.rejected ? "Send again" : "Not sent"}</span>}
                    </td>
                    <td className="row-actions">
                      {(st.waiting || st.approved)?.hasFile && <button className="btn-ghost sm" onClick={() => openFile(st.waiting || st.approved)}><FileText size={14} />View</button>}
                      {isOwner && <button className="btn-ghost sm" disabled={busy} onClick={() => { setErr(""); setForm({ kind, number: "", expiresOn: "", file: null }); }}>
                        <Upload size={14} />{st.approved || st.waiting ? "Replace" : "Send"}</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody></table>
            {form && (
              <form className="doc-form" onSubmit={send}>
                <h3>{DOCUMENT_LABELS[form.kind]}</h3>
                <div className="form-grid">
                  <label className="field"><span>Number (if it has one)</span><input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} maxLength={120} /></label>
                  <label className="field"><span>Expires on</span><input type="date" required value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} /></label>
                  <label className="field"><span>File (PDF or photo, up to {MAX_FILE_MB} MB)</span><input type="file" required accept="application/pdf,image/*" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] || null })} /></label>
                </div>
                <div className="cat-actions">
                  <button type="button" className="btn-ghost" onClick={() => setForm(null)}>Cancel</button>
                  <button className="btn-primary" disabled={busy}>{busy ? "Sending…" : "Send for review"}</button>
                </div>
              </form>
            )}
          </div>

          <div className="dash-card">
            <h2>Bank details</h2>
            <p className="field-hint">Where Sawa pays your company. A change is used only after Sawa verifies it, and you and Sawa are emailed about every change. The account holder must be {legalName || "your company's legal name"}.</p>
            {verified ? (
              <p><span className="tag tag-on">Verified</span> {verified.holderName} · {verified.bankName} · {verified.iban || verified.accountNumber}</p>
            ) : <p className="field-hint">No verified bank details yet.</p>}
            {pendingBank && <p><span className="tag tag-warn">Waiting for review</span> {pendingBank.bankName} · {pendingBank.iban || pendingBank.accountNumber}</p>}
            {!pendingBank && rejectedBank && !verified && <p className="field-hint doc-rejected">Not accepted: {rejectedBank.decisionNote}</p>}
            {isOwner && (bankForm ? (
              <form onSubmit={(e) => { e.preventDefault(); run(() => call("/agency/bank", "POST", bankForm).then(() => setBankForm(null)), "Bank details sent. Sawa will verify them."); }}>
                <div className="form-grid">
                  <label className="field"><span>Account holder</span><input value={bankForm.holderName} onChange={(e) => setBankForm({ ...bankForm, holderName: e.target.value })} required /></label>
                  <label className="field"><span>Bank</span><input value={bankForm.bankName} onChange={(e) => setBankForm({ ...bankForm, bankName: e.target.value })} required /></label>
                  <label className="field"><span>Account number</span><input value={bankForm.accountNumber} onChange={(e) => setBankForm({ ...bankForm, accountNumber: e.target.value })} /></label>
                  <label className="field"><span>IBAN</span><input value={bankForm.iban} onChange={(e) => setBankForm({ ...bankForm, iban: e.target.value })} placeholder="EG…" /></label>
                  <label className="field"><span>SWIFT (if relevant)</span><input value={bankForm.swift} onChange={(e) => setBankForm({ ...bankForm, swift: e.target.value })} /></label>
                </div>
                <div className="cat-actions">
                  <button type="button" className="btn-ghost" onClick={() => setBankForm(null)}>Cancel</button>
                  <button className="btn-primary" disabled={busy}>Send for verification</button>
                </div>
              </form>
            ) : <button className="btn-ghost sm" onClick={() => setBankForm({ holderName: legalName, bankName: "", accountNumber: "", iban: "", swift: "" })}>{verified || pendingBank ? "Change bank details" : "Add bank details"}</button>)}
          </div>
        </div>
      )}
    </>
  );
}
