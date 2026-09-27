// Agency portal → Settings: the signed-in person's own account (name,
// password) and the agency's contact details.
//
// There was no way to change a password from inside the portal at all. A new
// team member is handed a one-time password by the owner and told "they can
// change it after their first sign-in" (StaffPanel) — but the only route to a
// new password was signing out and using "Forgot password".
import React, { useState } from "react";
import { Check, KeyRound, UserRound, Building2 } from "lucide-react";
import { apiFetch } from "./supabaseClient";
import { supabase } from "./supabaseAuth.js";

const ROLE_LABEL = { agency_owner: "Owner", agency_agent: "Agent" };

export function AgencySettings({ user, agency, isOwner, onSaved }) {
  return (
    <>
      <div className="dash-head"><div><h1>Settings</h1><p>Your account, your password and your agency's details.</p></div></div>
      <div className="set-grid">
        <AccountCard user={user} onSaved={onSaved} />
        <PasswordCard email={user.email} />
        <AgencyCard agency={agency} isOwner={isOwner} onSaved={onSaved} />
      </div>
    </>
  );
}

function Status({ ok, err }) {
  if (err) return <div className="auth-error" role="alert">{err}</div>;
  if (ok) return <div className="set-ok" role="status"><Check size={15} />{ok}</div>;
  return null;
}

async function patch(path, body) {
  const r = await apiFetch(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Could not save. Please try again.");
  return j;
}

function AccountCard({ user, onSaved }) {
  const [name, setName] = useState(user.fullName || "");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [err, setErr] = useState("");
  const changed = name.trim() !== (user.fullName || "");

  async function save(e) {
    e.preventDefault();
    setOk(""); setErr("");
    if (!name.trim()) return setErr("Enter your name.");
    setBusy(true);
    try {
      await patch("/me", { fullName: name.trim() });
      setOk("Saved.");
      await onSaved?.();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form className="dash-card set-card" onSubmit={save}>
      <div className="dash-card-head"><h2><UserRound size={17} />Your account</h2></div>
      <label className="set-field">Name
        <input value={name} onChange={(e) => { setName(e.target.value); setOk(""); }} autoComplete="name" />
      </label>
      <label className="set-field">Email
        <input value={user.email || ""} readOnly disabled />
        <span className="field-hint">This is your sign-in. To change it, ask {user.role === "agency_owner" ? "Sawa" : "your agency owner"}.</span>
      </label>
      <label className="set-field">Role
        <input value={ROLE_LABEL[user.role] || user.role || ""} readOnly disabled />
      </label>
      <Status ok={ok} err={err} />
      <button className="btn-primary set-save" type="submit" disabled={busy || !changed}>{busy ? "Saving…" : "Save"}</button>
    </form>
  );
}

function PasswordCard({ email }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [err, setErr] = useState("");

  async function save(e) {
    e.preventDefault();
    setOk(""); setErr("");
    if (!current) return setErr("Enter your current password.");
    if (next.length < 8) return setErr("Use at least 8 characters for the new password.");
    if (next !== confirm) return setErr("The two new passwords don't match.");
    if (next === current) return setErr("Choose a password different from your current one.");
    setBusy(true);
    try {
      // Prove it is the account holder, not whoever found the laptop open:
      // the current password has to sign in before the new one is set.
      const { error: authErr } = await supabase.auth.signInWithPassword({ email, password: current });
      if (authErr) throw new Error(authErr.message === "Invalid login credentials" ? "Your current password is wrong." : authErr.message);
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw new Error(error.message);
      setCurrent(""); setNext(""); setConfirm("");
      setOk("Password changed. Use the new one next time you sign in.");
    } catch (e2) { setErr(e2.message || "Could not change the password."); } finally { setBusy(false); }
  }

  const type = shown ? "text" : "password";
  return (
    <form className="dash-card set-card" onSubmit={save}>
      <div className="dash-card-head"><h2><KeyRound size={17} />Password</h2></div>
      {/* The username field lets password managers file the new password
          against the right account. */}
      <input type="email" value={email || ""} autoComplete="username" readOnly hidden />
      <label className="set-field">Current password
        <input type={type} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="set-field">New password
        <input type={type} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        <span className="field-hint">At least 8 characters.</span>
      </label>
      <label className="set-field">Confirm new password
        <input type={type} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="set-check"><input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} /> Show passwords</label>
      <Status ok={ok} err={err} />
      <button className="btn-primary set-save" type="submit" disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
    </form>
  );
}

function AgencyCard({ agency, isOwner, onSaved }) {
  const [contactName, setContactName] = useState(agency?.contactName || "");
  const [phone, setPhone] = useState(agency?.phone || "");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [err, setErr] = useState("");
  const changed = contactName.trim() !== (agency?.contactName || "") || phone.trim() !== (agency?.phone || "");
  const verified = agency?.verificationState === "verified" || !!agency?.verifiedAt;

  async function save(e) {
    e.preventDefault();
    setOk(""); setErr("");
    setBusy(true);
    try {
      await patch("/agency/profile", { contactName: contactName.trim(), phone: phone.trim() });
      setOk("Saved.");
      await onSaved?.();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form className="dash-card set-card set-wide" onSubmit={save}>
      <div className="dash-card-head"><h2><Building2 size={17} />Agency details</h2>{verified && <span className="tag tag-on"><Check size={12} />Verified by Sawa</span>}</div>
      <div className="set-two">
        <label className="set-field">Company name
          <input value={agency?.name || ""} readOnly disabled />
        </label>
        <label className="set-field">Ministry of Tourism license
          <input value={agency?.tourismLicenseNo || "—"} readOnly disabled />
        </label>
        <label className="set-field">Contact person
          <input value={contactName} onChange={(e) => { setContactName(e.target.value); setOk(""); }} readOnly={!isOwner} disabled={!isOwner} autoComplete="off" />
        </label>
        <label className="set-field">Contact phone
          <input type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setOk(""); }} readOnly={!isOwner} disabled={!isOwner} autoComplete="off" />
        </label>
      </div>
      <p className="field-hint">
        The company name and license are part of your verified operator record; to change them, contact Sawa.
        {isOwner ? "" : " Only the agency owner can change the contact details."}
      </p>
      <Status ok={ok} err={err} />
      {isOwner && <button className="btn-primary set-save" type="submit" disabled={busy || !changed}>{busy ? "Saving…" : "Save"}</button>}
    </form>
  );
}
