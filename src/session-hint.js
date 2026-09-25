// P01 — whether apiFetch needs to load the Supabase auth client at all.
// Separate from supabaseClient.js so it can be tested without Vite.

// Has this browser a saved Supabase session? Supabase keeps it in
// localStorage under "sb-<project>-auth-token". When storage can't be read we
// answer yes: loading the auth client unnecessarily costs bytes; not loading it
// for a signed-in user would send their requests anonymously.
export function mayHaveSession(storage = globalThis.localStorage) {
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith("sb-") && k.endsWith("-auth-token")) return true;
    }
    return false;
  } catch {
    return true;
  }
}
