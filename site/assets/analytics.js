/* Google Analytics 4.
 *
 * The measurement ID lives here and nowhere else. The site is 18 standalone
 * static pages plus a server-rendered SPA, so pasting Google's snippet into
 * each one would put the ID in nineteen places and guarantee they drift.
 * Every page loads this file instead; the server injects it into SPA routes
 * via buildHead() in server/seo.js.
 *
 * window.gtag is defined before the remote script arrives — gtag is a queue
 * that drains into dataLayer once googletagmanager.com loads, so calls made in
 * the meantime (including page_view on SPA navigation) are not lost.
 *
 * Nothing here runs until consent.js reports an analytics consent. The queue is
 * still defined immediately, because callers elsewhere (SPA page_view on route
 * change) call gtag unconditionally and must not throw; without consent those
 * calls simply pile up in an array that no remote script ever drains.
 */
(function () {
  var ID = "G-VG2G0Q5JFM";
  var started = false;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  // A browser signed in to the dashboard (staff, an agency, an operator) is not
  // a visitor. Supabase keeps that session in localStorage under
  // "sb-<project>-auth-token" (the same test as src/session-hint.js, restated
  // because this is a plain script and cannot import it). Marked with GA4's own
  // traffic_type parameter, which the property's "Internal Traffic" data filter
  // excludes. Nothing new is stored: this only reads a key sign-in already set.
  // Unreadable storage answers no: better to count a colleague than to hide a
  // visitor.
  function signedIn() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("sb-") === 0 && /-auth-token$/.test(k)) return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function start() {
    if (started) return;
    started = true;

    window.gtag("js", new Date());
    if (signedIn()) window.gtag("config", ID, { traffic_type: "internal" });
    else window.gtag("config", ID);

    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
    (document.head || document.documentElement).appendChild(s);
  }

  // If consent.js is missing the safe reading is refusal, not "load anyway".
  if (!window.sawaConsent) return;
  window.sawaConsent.onChange(function (choice) {
    // Google's own kill switch. Once gtag.js is in the page it cannot be taken
    // out again, so a visitor who withdraws consent mid-session needs this as
    // well as the cookie clearing consent.js does — otherwise the script simply
    // writes _ga back on the next event.
    window["ga-disable-" + ID] = !choice.analytics;
    if (choice.analytics) start();
  });
})();
