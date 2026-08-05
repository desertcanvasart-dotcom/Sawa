import React, { useEffect, useState } from "react";
import { supabase, apiFetch } from "./supabaseClient";

// Wraps the staff/agency dashboards. Shows a login screen until a valid
// Supabase session AND a matching app profile (role + agency) are present.
// Passes { user, agency, signOut } to children via a render prop.
export function LoginGate({ children, onSession }) {
  const [status, setStatus] = useState("loading"); // loading | out | in
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

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data?.session) loadProfile(data.session.access_token);
      else setStatus("out");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!active) return;
      if (session) loadProfile(session.access_token);
      else { setProfile(null); setStatus("out"); onSession?.(null); }
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

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

  if (status === "out") {
    return <LoginForm error={error} onClearError={() => setError("")} />;
  }

  return children({ user: profile.user, agency: profile.agency, signOut });
}

function LoginForm({ error, onClearError }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

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

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="auth-brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>Sawa</strong>
            <span>Partner portal</span>
          </div>
        </div>
        <h1>Sign in</h1>
        <p className="auth-sub">For travel agencies and Sawa staff.</p>

        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" autoComplete="username"
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@agency.com" />
        </div>
        <div className="field">
          <label htmlFor="login-pw">Password</label>
          <input id="login-pw" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>

        {shownError && <div className="auth-error" role="alert">{shownError}</div>}

        <button className="primary full" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <a className="auth-back" href="/">← Back to the public site</a>
      </form>
    </main>
  );
}
