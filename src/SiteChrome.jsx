// The public site's frame: navigation, footer, the Sawa mark, loading and error screens, in-app links and section headings
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import React, { useState, useRef, useEffect } from "react";
import { ArrowRight } from "lucide-react";

// ============ Editorial home page (redesign), wired to live data ============
const SxArrow = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const SxLogoMark = () => (
  <svg className="mark" viewBox="0 0 100 100" aria-hidden="true">
    <circle className="ring" cx="50" cy="50" r="36" />
    <path className="s" d="M62 34 C44 34 44 50 52 50 C60 50 60 66 38 66" />
    <circle className="dot" cx="23" cy="40" r="5.5" /><circle className="dot" cx="31" cy="74" r="5.5" /><circle className="dot" cx="70" cy="62" r="5.5" />
    <circle className="go" cx="74" cy="30" r="6.5" />
  </svg>
);

// Global chrome — the editorial glass nav + footer, shared by every public page.
// Links point at the static editorial pages (served from /site) so the chrome is
// identical across the whole site. Real <a href> = full navigation out of the SPA
// back into the static pages; the SPA is only ever the tour-detail/booking body.
// Kept in step with the static pages' nav (site/*.html) — the detail page used to
// drop "The Promise", so a visitor who arrived on a tour page lost the link to
// the page that explains what they're being asked to trust.
// Plain <a> on purpose: /departures, /goahead and /destinations are static
// server pages, not SPA routes — SpaLink would client-route them into the 404.
// Mirrors the nav on the static pages; keep the two in sync.
const SX_NAV_LINKS = [["Itineraries", "/itineraries"], ["Departures", "/departures"], ["GoAhead", "/goahead"], ["How it works", "/how-it-works"], ["Blog", "/blog"]];

// The skip link the static pages all carry. It only becomes visible on focus,
// and it targets the #main that SxChrome/TourDetailV2 put on their <main>.
function SxSkipLink() {
  return (
    <a
      className="sx-skip"
      href="#main"
      onFocus={(e) => { e.currentTarget.style.left = "12px"; }}
      onBlur={(e) => { e.currentTarget.style.left = "-999px"; }}
    >
      Skip to content
    </a>
  );
}

function SxNav({ cta = ["Find a departure", "/departures"] }) {
  const [tight, setTight] = useState(false);
  const [menu, setMenu] = useState(false);
  const overlayRef = useRef(null);
  const openBtnRef = useRef(null);
  const closeBtnRef = useRef(null);
  useEffect(() => {
    const onScroll = () => setTight(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // The overlay is always in the DOM, so a closed menu has to be taken out of
  // the tab order AND the accessibility tree — otherwise a desktop screen-reader
  // user meets a "Close menu" button and a duplicate set of nav links that are
  // nowhere on screen. CSS visibility does it everywhere; `inert` also blocks
  // find-in-page where it's supported.
  useEffect(() => {
    const ov = overlayRef.current;
    if (ov && "inert" in HTMLElement.prototype) ov.inert = !menu;
    document.body.style.overflow = menu ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menu]);
  // Focus follows the menu: into it on open, back to the hamburger on close, so
  // a keyboard user is never stranded behind an invisible layer. Escape closes.
  useEffect(() => {
    if (!menu) return;
    closeBtnRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") closeMenu(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);
  // Focus moves back to the hamburger BEFORE the overlay goes inert — the other
  // order leaves activeElement inside a hidden container and the next Tab
  // restarts from the top of the document.
  function closeMenu() {
    openBtnRef.current?.focus();
    setMenu(false);
  }
  return (
    <>
      <SxSkipLink />
      <div className="nav-shell">
        <nav className={`nav${tight ? " tight" : ""}`} aria-label="Primary">
          <a className="logo" href="/"><SxLogoMark /><span className="nm"><b>Sawa</b><i>Tours · Egypt</i></span></a>
          <div className="nav-links">{SX_NAV_LINKS.map(([l, to]) => <a key={to} href={to}>{l}</a>)}</div>
          <div className="nav-right">
            <a className="btn gold sm" href={cta[1]}>{cta[0]}<span className="chip"><SxArrow /></span></a>
            <button ref={openBtnRef} className="menu-btn" aria-label="Open menu" aria-expanded={menu ? "true" : "false"} onClick={() => setMenu(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
          </div>
        </nav>
      </div>
      <div ref={overlayRef} className={`overlay${menu ? " open" : ""}`}>
        <button ref={closeBtnRef} className="close" aria-label="Close menu" onClick={closeMenu}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        {/* Links navigate away, so just close — restoring focus would fight the
            page load. */}
        {SX_NAV_LINKS.map(([l, to]) => <a key={to} href={to} onClick={() => setMenu(false)}>{l}</a>)}
      </div>
    </>
  );
}

function SxFooter() {
  return (
    <div className="sfooter">
      <div className="wrap">
        <div className="fgrid">
          <div><a className="logo" href="/"><SxLogoMark /><span className="nm"><b>Sawa</b><i>Tours · Egypt</i></span></a><p className="fblurb">Shared departures, confirmed together. Sawa pools travelers across Ministry-licensed Egyptian operators so the tours you want actually run.</p></div>
          <div className="fcol"><h4>Travel</h4><a href="/itineraries">All itineraries</a><a href="/departures">Open departures</a><a href="/goahead">GoAhead departures</a><a href="/destinations">Destinations</a><a href="/how-it-works">How it works</a><a href="/trust">The GoAhead promise</a><a href="/faq">FAQ</a></div>
          <div className="fcol"><h4>Operators</h4><a href="/partners">Operating partners</a><a href="/operators">List a tour</a><a href="/verify">List with Sawa</a><a href="/widget">Get the widget</a></div>
          <div className="fcol"><h4>Company</h4><a href="/about">About Sawa</a><a href="/contact">Support</a><a href="/privacy">Privacy Policy</a><a href="/cookies">Cookies</a><a href="/terms">Terms and Conditions</a>
            {/* U05 — the static pages get this link from consent.js, which adds it
                on load and on Back/Forward only; the SPA's own navigation never
                re-added it, so it went missing on tour pages. Rendered here, with
                the class consent.js looks for so it doesn't add a second one. */}
            <a href="#" className="ck-link" onClick={(e) => { e.preventDefault(); window.sawaConsent?.open?.(); }}>Cookie settings</a></div>
        </div>
        <div className="fbot"><span>© 2026 Sawa Tours · Operated by Online Era · Registration 148500</span></div>
      </div>
    </div>
  );
}

// Wraps a legacy (non-.sx) page body with the global glass nav + footer.
function SxChrome({ navigate, children }) {
  return (
    <>
      <div className="sx sx-chrome"><div className="grain" /><SxNav navigate={navigate} /></div>
      <main id="main" className="public-shell sx-shell-body">{children}</main>
      <div className="sx sx-chrome"><SxFooter navigate={navigate} /></div>
    </>
  );
}

const SxStar = () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" /></svg>;
const SxCheck = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
const SxX = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6 6 18" /></svg>;


function scrollToBooking(navigate) {
  const el = document.getElementById("live-departures");
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    navigate("/");
    window.setTimeout(() => {
      document.getElementById("live-departures")?.scrollIntoView({ behavior: "smooth" });
    }, 140);
  }
}

function SawaMark({ size = 30 }) {
  return (
    <svg className="sawa-mark" width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="12.4" stroke="currentColor" strokeWidth="1.4" opacity="0.8" />
      <path
        d="M21 11.4c0-2.3-3.2-3.1-5.4-1.9-2.1 1.1-2.1 3.7.6 4.8 3 1.2 3.4 4.1 1 5.4-2.2 1.2-5.4.3-5.4-2"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7.1" cy="7.1" r="2" fill="currentColor" />
      <circle cx="24.9" cy="7.1" r="2.5" fill="#f4c95d" />
      <circle cx="7.1" cy="24.9" r="2" fill="currentColor" />
      <circle cx="24.9" cy="24.9" r="2" fill="currentColor" />
    </svg>
  );
}

function SawaWordmark() {
  return (
    <span className="sawa-wordmark">
      <strong>Sawa</strong>
      <em>Tours</em>
    </span>
  );
}

function LoadingScreen({ label = "Preparing your shared departures…" }) {
  return (
    <main className="app-loader">
      <div className="app-loader-inner">
        <div className="app-loader-mark">
          <span className="app-loader-ring" aria-hidden="true" />
          <SawaMark size={52} />
        </div>
        <SawaWordmark />
        <span className="app-loader-sub">{label}</span>
      </div>
    </main>
  );
}

// A logo on an empty page says "something is happening somewhere" and nothing
// else — after a few seconds it reads as broken. A skeleton in the shape of the
// page that is coming says how much is coming and where, and it gives the eye
// somewhere to rest. Only reached now when a page arrives without an inlined
// payload (the SPA's own client-side route changes, or a cache miss).
function CatalogueSkeleton() {
  return (
    <main className="page-wrap" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading departures…</span>
      <div className="skel-head" aria-hidden="true">
        <span className="skel skel-kicker" />
        <span className="skel skel-title" />
        <span className="skel skel-lede" />
      </div>
      <div className="skel-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div className="skel-card" key={i}>
            <span className="skel skel-media" />
            <span className="skel skel-line w70" />
            <span className="skel skel-line w45" />
            <span className="skel skel-bar" />
            <span className="skel skel-line w60" />
          </div>
        ))}
      </div>
    </main>
  );
}

// Terminal state for a cold load that never produced data. The previous
// behaviour was to sit on the spinner indefinitely, which gave the visitor
// nothing to do and no way to tell a slow network from an outage.
function LoadErrorScreen({ onRetry }) {
  return (
    <main className="page-wrap page-404" role="alert">
      <div>
        <SawaMark size={48} />
        <h1>We couldn't load the departures.</h1>
        <p>
          This is usually a connection blip rather than a problem with your booking.
          Nothing you've done has been lost — no seat is held and nothing is charged.
        </p>
        <div className="page-404-actions">
          <button type="button" className="btn-pill primary" onClick={onRetry}>
            Try again
          </button>
          <a className="btn-pill" href="/contact">Contact us</a>
        </div>
      </div>
    </main>
  );
}

// Canonical public site — embed links always point here, wherever the widget
// is hosted.
const SITE_URL = "https://sawa.tours";

// ---- Scroll reveal ------------------------------------------------------
// One implementation for both observers in this file (.rv on a tour or package
// page, .reveal on the listing) and the same rule the static pages follow in
// /assets/sawa.js: an entrance animation is for content you scroll to. Anything
// already on screen when the view renders is shown as it is, or every route
// change blanks the viewport and then slides it — which on a phone is the whole
// screen, on every tap.
function observeReveal(root, selector, options) {
  const els = Array.from((root || document).querySelectorAll(selector));
  if (!els.length) return () => {};
  if (!("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("in"));
    return () => {};
  }

  const above = [], below = [];
  els.forEach((el) => (el.getBoundingClientRect().top < window.innerHeight ? above : below).push(el));

  above.forEach((el) => {
    el.style.transition = "none";
    el.classList.add("in");
    el.querySelectorAll("[data-fill]").forEach((b) => { b.style.width = b.dataset.fill; });
  });
  // Commits the revealed state while the transition is still off; without it
  // the browser coalesces both changes and animates anyway.
  if (above.length) void document.body.offsetHeight;
  requestAnimationFrame(() => above.forEach((el) => { el.style.transition = ""; }));

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      e.target.querySelectorAll("[data-fill]").forEach((b) => { b.style.width = b.dataset.fill; });
      io.unobserve(e.target);
    });
  }, options);
  below.forEach((el) => io.observe(el));
  return () => io.disconnect();
}

function SectionHeading({ kicker, title }) {
  return (
    <div className="section-heading">
      <p>{kicker}</p>
      <h2>{title}</h2>
    </div>
  );
}

// Renders trusted admin-authored HTML (TipTap output), or plain-text fallback.
// ============================================================
// PUBLIC PAGES — standalone marketing / legal / utility pages
// ============================================================

function PageHead({ eyebrow, title, lead }) {
  return (
    <header className="page-head reveal in">
      {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {lead && <p className="page-lead">{lead}</p>}
    </header>
  );
}

// Shared closing call-to-action used across marketing pages.
function PageCTA({ navigate, note }) {
  return (
    <section className="page-cta reveal in">
      {note && <p className="page-cta-note"><span className="live-dot" aria-hidden="true" />{note}</p>}
      <h2>Ready when your group is.</h2>
      <p>Hold a seat for free and watch it turn GoAhead.</p>
      <button className="btn-pill primary lg" onClick={() => navigate("/itineraries")}>Browse itineraries <ArrowRight size={18} /></button>
    </section>
  );
}

// Every catalogue card used <button onClick={navigate}>, which cost three
// things a link gives for free: cmd/middle-click to open in a new tab, a
// distinguishable accessible name (screen readers heard a run of identical
// "View tour" buttons), and an href for crawlers. This renders a real anchor
// and only hijacks the plain left click, so modified clicks fall through to the
// browser. The ::after in CSS stretches the hit area over the whole card, so
// there is exactly one link per card rather than a title/CTA duplicate pair.
function SpaLink({ navigate, to, label, className, children, ...rest }) {
  return (
    <a
      // rest is spread FIRST so a caller's styling props come through, but can
      // never overwrite href/onClick and silently turn this back into a div.
      {...rest}
      className={className}
      href={to}
      aria-label={label}
      onClick={(event) => {
        // Modified and non-primary clicks are the browser's to handle: this is
        // what makes cmd-click / middle-click open a new tab as users expect.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function CardLink(props) {
  return <SpaLink {...props} className="card-link" />;
}

export {
  SxArrow, SxLogoMark, SX_NAV_LINKS, SxSkipLink, SxNav, SxFooter, SxChrome, SxStar, SxCheck, SxX,
  scrollToBooking, SawaMark, SawaWordmark, LoadingScreen, CatalogueSkeleton, LoadErrorScreen, SITE_URL,
  observeReveal, SectionHeading, PageHead, PageCTA, SpaLink, CardLink,
};
