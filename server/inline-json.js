// JSON destined for inside a <script> block, which is NOT the same as JSON in a
// response body. The HTML parser ends the block at the first "</script>"
// anywhere in the text — including inside a JSON string — so a tour titled
// `</script><img onerror=...>` would break out and execute. Escaping "<" shuts
// that off. U+2028/U+2029 are legal in JSON but are line terminators in JS
// source, so leaving them raw is a syntax error that blanks the payload.
//
// Lives in its own module because both the SPA head builder (seo.js, which
// imports the database) and the static-page schema builder (static-seo.js,
// which deliberately does not) need it. Duplicating an escaper that exists to
// stop script injection is not the kind of duplication to be relaxed about.
export function inlineScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export const ldScript = (obj) =>
  `<script type="application/ld+json">${inlineScriptJson(obj)}</script>`;
