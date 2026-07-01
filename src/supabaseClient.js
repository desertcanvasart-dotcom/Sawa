import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// In dev, point at the standalone API. In production the SPA is served by the
// same Express process, so default to a same-origin relative path.
export const API_BASE =
  import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? "http://localhost:8787/api" : "/api");

// Fetch wrapper that attaches the current Supabase access token.
export async function apiFetch(path, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

// Read a File as a base64 data URL.
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Upload an image File via the admin endpoint; returns its public URL.
export async function uploadImage(file) {
  if (file.size > 6 * 1024 * 1024) throw new Error("Image is larger than 6MB.");
  const dataUrl = await fileToDataUrl(file);
  const res = await apiFetch("/admin/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, dataUrl }),
  });
  // Error bodies aren't always JSON (proxies, 413s), so parse defensively and
  // map the common failures to messages that actually tell the user what to do.
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error("Your session has expired — please sign in again.");
    if (res.status === 403) throw new Error("This account can't upload images. Ask an admin to check your access.");
    if (res.status === 413) throw new Error("That image is too large. Please use one under 6MB.");
    throw new Error(json.error || "Upload failed. Please try again.");
  }
  return json.url;
}
