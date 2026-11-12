// The URL of a photo at a given display width (12 Nov 2026).
//
// server/image-variants.js answers /images/<file>.jpg?w=480|800|1200 with the
// photo scaled to that width, and in WebP where the browser takes it. Pages
// ask for the width they show a photo at; anything not under /images (an
// uploaded photo in Supabase storage, a data URL) is returned untouched.
//
// Shared because the app (src/) and the static home page script (site/) both
// build card URLs, and the widths must be the ones the server accepts.
export const IMAGE_WIDTHS = [480, 800, 1200];

export function sizedImage(url, width) {
  if (typeof url !== "string" || !IMAGE_WIDTHS.includes(width)) return url;
  if (!/^\/images\/[\w./-]+\.(jpe?g|png)$/i.test(url)) return url;
  return `${url}?w=${width}`;
}

// srcset for an <img>: every width the server makes, so the browser picks by
// the `sizes` the page gives it.
export function imageSrcSet(url) {
  if (sizedImage(url, IMAGE_WIDTHS[0]) === url) return undefined;
  return IMAGE_WIDTHS.map((w) => `${url}?w=${w} ${w}w`).join(", ");
}
