// Links inside the widget must never navigate the frame itself: "/terms"
// clicked in an iframe would load the whole Sawa site inside the partner's
// page. Anything that is not already opening a new tab is opened in one.
export function keepLinksOutOfFrame(e) {
  const a = e.target?.closest?.("a[href]");
  if (!a || a.target === "_blank") return;
  const href = a.getAttribute("href") || "";
  if (!href || href.startsWith("#") || /^(mailto|tel):/i.test(href)) return;
  e.preventDefault();
  window.open(new URL(href, window.location.origin).href, "_blank", "noopener,noreferrer");
}
