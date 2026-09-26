// Receipts for tour cost lines (044), uploaded as files.
//
// A receipt is a financial document — an operator's invoice, a coach
// contract — so it does NOT go where tour photos go. `tour-images` is a public
// bucket; receipts live in a PRIVATE bucket and are only ever opened through a
// short-lived signed link, issued to Sawa staff or to the agency that
// uploaded the file.
//
// A cost line's `receipt_url` holds either a pasted https link (as before) or
// a reference to an uploaded file: `receipts:<storage key>`. No migration: the
// column already exists and nothing else reads it.
//
// Keys carry who uploaded them — `agency/<agencyId>/…` or `sawa/…` — so an
// agency can only attach a receipt it uploaded itself.

export const RECEIPT_BUCKET = "cost-receipts";
export const RECEIPT_PREFIX = "receipts:";
export const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
export const SIGNED_LINK_SECONDS = 120;

const TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
export const RECEIPT_MIME_TYPES = Object.keys(TYPES);

// { contentType, ext, buffer } from a data URL, or { error }.
export function parseReceiptDataUrl(dataUrl) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!m) return { error: "No file received." };
  const contentType = m[1].toLowerCase();
  const ext = TYPES[contentType];
  if (!ext) return { error: "Upload a PDF or a photo (JPG, PNG, WEBP or HEIC)." };
  const buffer = Buffer.from(m[2], "base64");
  if (!buffer.length) return { error: "That file is empty." };
  if (buffer.length > RECEIPT_MAX_BYTES) return { error: "That file is larger than 8MB." };
  return { contentType: contentType === "image/jpg" ? "image/jpeg" : contentType, ext, buffer };
}

// Where an upload goes: under its uploader, with a random part so keys can't
// be guessed, and the original name kept (lower-cased, safe) for display.
export function receiptKey({ agencyId = null, filename = "receipt", ext, now = Date.now(), rand = Math.random().toString(36).slice(2, 10) }) {
  const owner = agencyId ? `agency/${String(agencyId).replace(/[^a-zA-Z0-9_-]/g, "")}` : "sawa";
  const safe = String(filename || "receipt").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "receipt";
  return `${owner}/${now}-${rand}-${safe}.${ext}`;
}

export const isReceiptRef = (v) => typeof v === "string" && v.startsWith(RECEIPT_PREFIX);
export const receiptRefKey = (v) => (isReceiptRef(v) ? v.slice(RECEIPT_PREFIX.length) : null);

// May this uploader attach this reference? Staff may attach any; an agency
// only a file under its own prefix. Keys are checked for shape so a crafted
// reference cannot reach outside the bucket's layout.
export function mayAttachReceipt(ref, { agencyId = null, staff = false } = {}) {
  const key = receiptRefKey(ref);
  if (!key || !/^(sawa|agency\/[a-zA-Z0-9_-]+)\/[0-9]+-[a-z0-9]+-[a-z0-9-]+\.(pdf|jpg|png|webp|heic|heif)$/.test(key)) return false;
  if (staff) return true;
  return !!agencyId && key.startsWith(`agency/${agencyId}/`);
}

// How the page can preview it: a PDF inline, a photo as a thumbnail. HEIC
// photos are stored as uploaded, but most browsers can't draw them, so they
// are offered as a file to open.
export function receiptKind(ref) {
  const ext = (receiptRefKey(ref) || "").split(".").pop();
  if (ext === "pdf") return "pdf";
  if (["jpg", "png", "webp"].includes(ext)) return "image";
  return ref && isReceiptRef(ref) ? "file" : null;
}

// The file name shown beside a cost line: "coach-contract.pdf".
export function receiptDisplayName(ref) {
  const key = receiptRefKey(ref);
  if (!key) return null;
  const m = /\/[0-9]+-[a-z0-9]+-(.+)$/.exec(key);
  return m ? m[1] : key.split("/").pop();
}
