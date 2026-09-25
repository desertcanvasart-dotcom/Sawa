// The Supabase auth client — sign-in, sessions, password reset.
//
// P01 — kept out of the public bundle. The library is ~200 kB minified and an
// anonymous visitor (nearly every visitor) never signs in, yet it loaded on
// every page because supabaseClient.js created the client at import. Only the
// sign-in screen and the dashboards import this module, and they are already
// lazy-loaded; apiFetch loads it on demand when a saved session exists.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
