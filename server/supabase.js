import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
}

// Anon client — used to validate user access tokens.
export const supabaseAnon = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Service-role client — used by admin operations (creating users, invites).
// Only ever used server-side. NEVER expose the service key to the browser.
export const supabaseAdmin = serviceKey
  ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// Validate a user access token and return the Supabase auth user (or null).
export async function getAuthUser(accessToken) {
  if (!accessToken) return null;
  const { data, error } = await supabaseAnon.auth.getUser(accessToken);
  if (error || !data?.user) return null;
  return data.user;
}
