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
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Upload failed.");
  return json.url;
}
