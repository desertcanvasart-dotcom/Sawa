// Server-side HTML sanitization for rich-text fields.
//
// Agency users (a semi-trusted role) can submit tour listings whose overview,
// policies, and itinerary bodies are rich HTML, and staff/public browsers render
// that HTML with dangerouslySetInnerHTML. The TipTap editor's client-side output
// is NOT a security boundary — anyone can POST arbitrary HTML straight to the API.
// So every HTML field is sanitized here, on write, before it is stored.
//
// The allow-list matches what the editor (StarterKit + Link) can produce; anything
// else — <script>, event handlers, javascript: URLs, style/iframe — is stripped.
import sanitizeHtml from "sanitize-html";

const OPTIONS = {
  allowedTags: [
    "p", "br", "hr", "span",
    "strong", "b", "em", "i", "u", "s", "code", "pre", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "a",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  // Force outbound links to be safe (no window.opener access, no referrer leak).
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
  },
  // Drop the *contents* of these entirely, not just the tags.
  nonTextTags: ["style", "script", "textarea", "option", "noscript"],
};

// Sanitize a single HTML string. Returns "" for empty/non-string input so callers
// can store NULL consistently.
export function cleanHtml(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  return sanitizeHtml(value, OPTIONS);
}

// Sanitize the free-text "description" of each itinerary day (packages), leaving
// the rest of the day object (day number, title) untouched. Non-arrays pass through.
export function cleanItinerary(itinerary) {
  if (!Array.isArray(itinerary)) return itinerary;
  return itinerary.map((day) =>
    day && typeof day === "object" && typeof day.description === "string"
      ? { ...day, description: cleanHtml(day.description) }
      : day
  );
}
