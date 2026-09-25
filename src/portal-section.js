// The dashboard's sidebar sections as real URLs.
//
// Sections used to be React state only, so the whole portal was one history
// entry: opening "My bookings" and pressing the browser's Back button left the
// site entirely instead of returning to the section before. Each section now
// pushes its own entry — /portal/bookings, /portal/departures — and Back and
// Forward walk through them. The server already serves the SPA for every
// /portal/* path (server/app.js, the "/*all" route), and a reload or a shared
// link lands on the same section.
import { useEffect, useState } from "react";

// "/portal/bookings" -> "bookings"; anything unknown -> the fallback, so an old
// or mistyped link still opens the dashboard rather than an empty page.
export function sectionFromPath(pathname, ids, fallback) {
  const seg = String(pathname || "").split("/")[2] || "";
  return ids.includes(seg) ? seg : fallback;
}

// "/portal" + "bookings" -> "/portal/bookings". The first segment is kept as
// it arrived (/portal, /admin or /agency all open the dashboard), and the
// default section is the bare root, so /portal stays the canonical link.
export function pathForSection(pathname, id, fallback) {
  const root = "/" + (String(pathname || "").split("/")[1] || "portal");
  return id === fallback ? root : `${root}/${id}`;
}

export function usePortalSection(ids, fallback) {
  const read = () => sectionFromPath(window.location.pathname, ids, fallback);
  const [section, setSection] = useState(read);

  useEffect(() => {
    const onPop = () => setSection(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // ids is rebuilt each render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join("|"), fallback]);

  function go(id) {
    if (!ids.includes(id)) return;
    const to = pathForSection(window.location.pathname, id, fallback);
    if (to !== window.location.pathname) window.history.pushState({}, "", to);
    setSection(id);
    window.scrollTo({ top: 0 });
  }

  return [section, go];
}
