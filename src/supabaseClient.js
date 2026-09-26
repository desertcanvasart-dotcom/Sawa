import { warnOnce } from "./warn-once.js";
import { mayHaveSession } from "./session-hint.js";

// The auth client lives in supabaseAuth.js and is loaded only when needed —
// see the note there (P01).

// In dev, point at the standalone API. In production the SPA is served by the
// same Express process, so default to a same-origin relative path.
export const API_BASE =
  import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? "http://localhost:8787/api" : "/api");

// Fetch wrapper that attaches the current Supabase access token — loading the
// auth client only when there can be one (P01).
export async function apiFetch(path, options = {}) {
  let token = null;
  if (mayHaveSession()) {
    // A chunk that fails to load (a flaky mobile connection) must not take the
    // request down with it: it goes out anonymously, which every public
    // endpoint serves, and a portal endpoint answers 401 so the sign-in screen
    // takes over.
    try {
      const { supabase } = await import("./supabaseAuth.js");
      const { data } = await supabase.auth.getSession();
      token = data?.session?.access_token;
    } catch (e) {
      warnOnce("auth-load", "[auth] couldn't load the sign-in session — continuing without it:", e.message);
    }
  }
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

// Upload a receipt for a tour cost line (a PDF or a photo) to the PRIVATE
// receipts store; returns { ref, name } — send `ref` as the cost's receiptUrl.
export async function uploadReceipt(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error("That file is larger than 8MB.");
  const dataUrl = await fileToDataUrl(file);
  const res = await apiFetch("/cost-receipts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, dataUrl }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error("Your session has expired — please sign in again.");
    if (res.status === 413) throw new Error("That file is too large. Please use one under 8MB.");
    throw new Error(json.error || "The receipt didn't upload. Please try again.");
  }
  return json;
}

// Open an uploaded receipt in a new tab through a short-lived signed link.
// The tab is opened first, synchronously, so a pop-up blocker doesn't stop it
// for having been opened after a network request.
export async function openReceipt(costId) {
  const tab = window.open("", "_blank");
  try {
    const res = await apiFetch(`/cost-receipts/${costId}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Couldn't open the receipt.");
    if (tab) tab.location.href = json.url; else window.location.href = json.url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}

