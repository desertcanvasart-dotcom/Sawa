// Reads data the server inlined into the page as
// <script type="application/json" id="…"> (server/inline-json.js dataScript).
// Null when the block is missing or not valid JSON, so the caller falls back
// to fetching, as it did when the payload was absent.
export function readInlineData(id, doc = typeof document !== "undefined" ? document : null) {
  try {
    const text = doc?.getElementById(id)?.textContent;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
