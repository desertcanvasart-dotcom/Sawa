/* Google Tag Manager — container GTM-MJNDLPKG.
 *
 * Google's published snippet is meant to be pasted into every <head> on the
 * site. This site is twenty standalone static pages plus a server-rendered SPA
 * shell, so pasting it would put the container ID in twenty-one places and
 * guarantee they drift — the same argument analytics.js makes for the GA4
 * measurement ID. Every page loads this file instead; the server injects it
 * into SPA routes via buildHead() in server/seo.js.
 *
 * The other change from Google's snippet is that it does not run on load.
 * site/cookies.html tells visitors that analytics only runs with their
 * permission, and consent.js is the thing that says so. GTM loading itself
 * unconditionally would fire the container's tags — and set their cookies —
 * before anyone had been asked, which would make that page a false statement.
 * So the loader waits for the analytics consent, exactly as analytics.js does.
 *
 * The <noscript> iframe half of Google's snippet is still written into each
 * page's body directly: no script runs in the case it exists for, so there is
 * nothing there for this file to gate.
 */
(function () {
  var ID = "GTM-MJNDLPKG";
  var started = false;

  // Defined immediately, before any consent: dataLayer is a plain array that
  // anything on the page may push to, and a push made before the container
  // loads is not lost — gtm.js drains what is already there when it arrives.
  window.dataLayer = window.dataLayer || [];

  function start() {
    if (started) return;
    started = true;

    window.dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });

    var j = document.createElement("script");
    j.async = true;
    j.src = "https://www.googletagmanager.com/gtm.js?id=" + ID;
    (document.head || document.documentElement).appendChild(j);
  }

  // If consent.js is missing the safe reading is refusal, not "load anyway".
  if (!window.sawaConsent) return;
  window.sawaConsent.onChange(function (choice) {
    if (choice.analytics) start();
  });
})();
