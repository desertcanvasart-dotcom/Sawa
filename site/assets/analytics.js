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
 */
(function () {
  var ID = "G-VG2G0Q5JFM";

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", ID);

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  (document.head || document.documentElement).appendChild(s);
})();
