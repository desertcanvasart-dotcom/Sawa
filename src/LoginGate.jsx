import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "./supabaseClient";
import { supabase } from "./supabaseAuth.js";

// Tokens in the URL fragment shouldn't outlive the exchange — they end up in
// browser history and in anything the visitor pastes or shares.
function stripAuthHash() {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

// Wraps the staff/agency dashboards. Shows a login screen until a valid
// Supabase session AND a matching app profile (role + agency) are present.
// Passes { user, agency, signOut } to children via a render prop.
// A recovery link lands back here as "#access_token=…&type=recovery". Supabase
// turns that into a real session, so without this check the visitor would be
// signed straight into the dashboard and never get to choose a new password —
// the one thing they clicked the link to do. Read from the URL rather than
// waiting for the PASSWORD_RECOVERY event, because getSession() can resolve
// first and start loading the profile before the event fires.
function isRecoveryLink() {
  if (typeof window === "undefined") return false;
  return /(^|[#&?])type=recovery(&|$)/.test(window.location.hash + window.location.search);
}

export function LoginGate({ children, onSession }) {
  const [status, setStatus] = useState("loading"); // loading | out | in | recover
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");

  async function loadProfile(token) {
    try {
      const res = await apiFetch("/me");
      if (!res.ok) {
        // Only 401/403 mean this account genuinely has no portal access. Any
        // other failure — 429 from the rate limiter, 502/503 mid-deploy, a
        // gateway timeout — is transient, and signing the user out over it
        // destroyed a valid session and blamed their account for a server
        // hiccup ("contact your administrator"). Keep them signed in and say
        // what actually happened.
        if (res.status === 401 || res.status === 403) {
          await supabase.auth.signOut();
          setProfile(null);
          setStatus("out");
          onSession?.(null);
          setError("This account is not set up for the portal. Contact your administrator.");
        } else {
          setProfile(null);
          setStatus("out");
          onSession?.(null);
          setError(
            res.status === 429
              ? "Too many requests just now. Wait a moment and sign in again."
              : "The server is temporarily unavailable. Please try again in a moment."
          );
        }
        return;
      }
      const data = await res.json();
      setProfile(data);
      setStatus("in");
      onSession?.(token || "in");
    } catch (e) {
      // Network-level failure (offline, DNS, CORS). The Supabase session is
      // still valid, so don't sign out — just surface it.
      setProfile(null);
      setStatus("out");
      onSession?.(null);
      setError("Could not reach the server. Check your connection and try again.");
    }
  }

  // A ref, not state: the auth listener below is registered once and closes over
  // its initial render, so reading `status` there would always see "loading".
  const recovering = useRef(false);

  useEffect(() => {
    let active = true;
    // Set synchronously, before either async path can resolve.
    if (isRecoveryLink()) { recovering.current = true; setStatus("recover"); }

    supabase.auth.getSession().then(({ data }) => {
      if (!active || recovering.current) return;
      if (data?.session) loadProfile(data.session.access_token);
      else setStatus("out");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY") { recovering.current = true; setStatus("recover"); return; }
      // The session that arrives with a recovery link must not be treated as a
      // normal sign-in until a new password has actually been set — otherwise
      // the visitor is dropped into the dashboard with the old password intact.
      if (recovering.current) return;
      if (session) loadProfile(session.access_token);
      else { setProfile(null); setStatus("out"); onSession?.(null); }
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  // Called once the new password is saved: drop the recovery hold and continue
  // into the portal on the session the link already established.
  async function finishRecovery() {
    recovering.current = false;
    stripAuthHash();
    const { data } = await supabase.auth.getSession();
    if (data?.session) loadProfile(data.session.access_token);
    else setStatus("out");
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
    setStatus("out");
  }

  if (status === "loading") {
    return (
      <main className="app-loader">
        <div className="app-loader-inner">
          <div className="app-loader-mark">
            <span className="app-loader-ring" aria-hidden="true" />
            <svg className="sawa-mark" width="52" height="52" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <circle cx="16" cy="16" r="12.4" stroke="currentColor" strokeWidth="1.4" opacity="0.8" />
              <path d="M21 11.4c0-2.3-3.2-3.1-5.4-1.9-2.1 1.1-2.1 3.7.6 4.8 3 1.2 3.4 4.1 1 5.4-2.2 1.2-5.4.3-5.4-2" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="7.1" cy="7.1" r="2" fill="currentColor" />
              <circle cx="24.9" cy="7.1" r="2.5" fill="#f4c95d" />
              <circle cx="7.1" cy="24.9" r="2" fill="currentColor" />
              <circle cx="24.9" cy="24.9" r="2" fill="currentColor" />
            </svg>
          </div>
          <span className="sawa-wordmark"><strong>Sawa</strong><em>Tours</em></span>
          <span className="app-loader-sub">Signing you in…</span>
        </div>
      </main>
    );
  }

  if (status === "recover") {
    return <SetNewPasswordForm onDone={finishRecovery} />;
  }

  if (status === "out") {
    return <LoginForm error={error} onClearError={() => setError("")} />;
  }

  // Settings changes the name and agency details this profile holds; re-read
  // it without the sign-in path's side effects.
  const refreshProfile = async () => {
    const res = await apiFetch("/me");
    if (res.ok) setProfile(await res.json());
  };
  return children({ user: profile.user, agency: profile.agency, signOut, refreshProfile });
}

// Shared shell so the three auth views can't drift apart visually.
function AuthShell({ title, sub, children }) {
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>Sawa</strong>
            <span>Partner portal</span>
          </div>
        </div>
        <h1>{title}</h1>
        <p className="auth-sub">{sub}</p>
        {children}
      </div>
    </main>
  );
}

// A password field with a reveal toggle. Typing a password blind is the main
// reason people fail a login they actually know the credentials for, and it is
// worse on phones where autocorrect and small keys make slips likelier.
function PasswordField({ id, label, value, onChange, autoComplete, placeholder = "••••••••" }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pw-wrap">
        <input
          id={id}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
        />
        {/* type="button" — inside a form, a bare <button> submits it. */}
        <button
          type="button"
          className="pw-toggle"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-controls={id}
          aria-label={shown ? "Hide password" : "Show password"}
          title={shown ? "Hide password" : "Show password"}
        >
          {shown ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l18 18M10.6 10.7a2 2 0 002.8 2.8" />
              <path d="M16.7 16.8A9.6 9.6 0 0112 18c-5 0-9-6-9-6a17 17 0 014.1-4.7M9.9 5.2A9.7 9.7 0 0112 5c5 0 9 6 9 6a17.2 17.2 0 01-2.2 2.9" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z" />
              <circle cx="12" cy="12" r="2.6" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// Step 2 of recovery: the link has established a session, now set the password.
function SetNewPasswordForm({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (password.length < 8) { setErr("Use at least 8 characters."); return; }
    if (password !== confirm) { setErr("Those two passwords don't match."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      // The commonest cause by far is an expired or already-used link.
      setErr(
        /expired|invalid|not found/i.test(error.message)
          ? "That reset link has expired. Request a new one from the sign-in page."
          : error.message
      );
      setBusy(false);
      return;
    }
    onDone();
  }

  return (
    <AuthShell title="Choose a new password" sub="Then we'll take you straight into the portal.">
      <form className="auth-form" onSubmit={submit} noValidate>
        <PasswordField id="new-pw" label="New password" value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <PasswordField id="new-pw2" label="Confirm new password" value={confirm}
          onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        {err && <div className="auth-error" role="alert">{err}</div>}
        <button className="primary full" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save password"}
        </button>
      </form>
    </AuthShell>
  );
}

// Step 1 of recovery: ask Supabase to email a link.
function ForgotPasswordForm({ initialEmail, onBack }) {
  const [email, setEmail] = useState(initialEmail || "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!email.trim()) { setErr("Enter the email you sign in with."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      // Land back on the portal; LoginGate detects the recovery hash there.
      redirectTo: `${window.location.origin}/agency`,
    });
    setBusy(false);
    if (error) {
      setErr(/rate|limit|seconds/i.test(error.message)
        ? "Too many requests just now — wait a minute and try again."
        : error.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <AuthShell title="Check your email" sub={`If an account exists for ${email.trim()}, a reset link is on its way.`}>
        <p className="auth-note">
          The link is valid for a short time and can be used once. If it doesn't arrive within
          a few minutes, check spam, then try again.
        </p>
        <button className="primary full" type="button" onClick={onBack}>Back to sign in</button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password" sub="We'll email you a link to set a new one.">
      <form className="auth-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="reset-email">Email</label>
          <input id="reset-email" type="email" autoComplete="username" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@agency.com" />
        </div>
        {err && <div className="auth-error" role="alert">{err}</div>}
        <button className="primary full" type="submit" disabled={busy}>
          {busy ? "Sending…" : "Email me a reset link"}
        </button>
        <button className="auth-link" type="button" onClick={onBack}>← Back to sign in</button>
      </form>
    </AuthShell>
  );
}

function LoginForm({ error, onClearError }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [forgot, setForgot] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setLocalError("");
    onClearError?.();
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) {
      setLocalError(err.message === "Invalid login credentials" ? "Wrong email or password." : err.message);
      setBusy(false);
    }
    // On success, onAuthStateChange in LoginGate takes over.
  }

  const shownError = localError || error;

  if (forgot) {
    // Carry the typed address across so it doesn't have to be retyped.
    return <ForgotPasswordForm initialEmail={email} onBack={() => setForgot(false)} />;
  }

  return (
    <AuthShell title="Sign in" sub="For travel agencies and Sawa staff.">
      <form className="auth-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" autoComplete="username"
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@agency.com" />
        </div>

        <PasswordField id="login-pw" label="Password" value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />

        {shownError && <div className="auth-error" role="alert">{shownError}</div>}

        <button className="primary full" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <button className="auth-link" type="button" onClick={() => { setForgot(true); setLocalError(""); onClearError?.(); }}>
          Forgot your password?
        </button>
      </form>
      <a className="auth-back" href="/">← Back to the public site</a>
    </AuthShell>
  );
}
