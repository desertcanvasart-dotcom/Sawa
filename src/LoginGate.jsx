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
        // Logged into Supabase but no app profile / disabled -> treat as out.
        await supabase.auth.signOut();
        setProfile(null);
        setStatus("out");
        onSession?.(null);
        setError("This account is not set up for the portal. Contact your administrator.");
        return;
      }
      const data = await res.json();
      setProfile(data);
      setStatus("in");
      onSession?.(token || "in");
    } catch (e) {
      setError("Could not reach the server.");
      setStatus("out");
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
      <main className="auth-screen">
        <div className="auth-card"><div className="brand-mark">S</div><p>Loading…</p></div>
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
