/* Cookie consent.
 *
 * Loaded before analytics.js on every page, and injected into SPA routes by
 * buildHead() in server/seo.js. Nothing optional may run until this file says
 * so, which is why it carries its own stylesheet and markup rather than
 * depending on sawa.css: index.html, how-it-works.html and the six destination
 * pages do not load that stylesheet, and a banner that styled itself on twelve
 * pages out of twenty would be worse than none.
 *
 * The categories match site/cookies.html exactly. If one changes, change both,
 * and bump VERSION so a stored choice about a different set of purposes is not
 * treated as a choice about this one.
 */
(function () {
  var KEY = "sawa_consent";
  var VERSION = 1;
  var LIFETIME_DAYS = 365;

  // Strictly necessary is absent on purpose: it is not a choice, so offering a
  // switch for it would be theatre.
  var CATEGORIES = ["functional", "analytics"];

  var listeners = [];
  var state = null;

  /* ---- storage ---------------------------------------------------------- */

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || saved.v !== VERSION) return null;
      // A choice older than its lifetime is not a current choice.
      if (Date.now() - Date.parse(saved.ts) > LIFETIME_DAYS * 864e5) return null;
      return saved;
    } catch (e) { return null; }
  }

  function write(choice) {
    state = { v: VERSION, ts: new Date().toISOString(), functional: !!choice.functional, analytics: !!choice.analytics };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage blocked */ }
    listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
    clearDeclined();
  }

  // Withdrawing consent has to actually remove what was set, or "you can change
  // your mind" is a promise the page does not keep. Google's cookies are on our
  // own domain, so we can expire them ourselves.
  function clearDeclined() {
    if (!state.analytics) {
      document.cookie.split(";").forEach(function (c) {
        var name = c.split("=")[0].trim();
        if (name.indexOf("_ga") !== 0) return;
        var host = location.hostname;
        var paths = ["/", location.pathname];
        var domains = [host, "." + host, "." + host.split(".").slice(-2).join(".")];
        paths.forEach(function (p) {
          domains.forEach(function (d) {
            document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:01 GMT; path=" + p + "; domain=" + d;
          });
          document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:01 GMT; path=" + p;
        });
      });
    }
    if (!state.functional) {
      try {
        localStorage.removeItem("sawa_ref");
        for (var i = sessionStorage.length - 1; i >= 0; i--) {
          var k = sessionStorage.key(i);
          if (k && k.indexOf("sawa_ref_hit_") === 0) sessionStorage.removeItem(k);
        }
      } catch (e) {}
    }
  }

  /* ---- public API ------------------------------------------------------- */

  state = read();

  window.sawaConsent = {
    // null means undecided — which is not the same as refused, but must be
    // treated the same way by anything that would set an optional cookie.
    get: function () { return state; },
    has: function (category) { return !!(state && state[category]); },
    onChange: function (fn) { listeners.push(fn); if (state) fn(state); },
    open: function () { render(true); },
  };

  /* ---- styles ----------------------------------------------------------- */

  var CSS = [
    '.ck-scrim{position:fixed;inset:0;background:rgba(21,40,46,.44);z-index:9998;opacity:0;transition:opacity .3s ease}',
    '.ck-scrim.in{opacity:1}',
    '.ck{position:fixed;z-index:9999;left:16px;right:16px;bottom:16px;margin:0 auto;max-width:44rem;background:var(--paper,#fbf8f1);color:var(--ink,#15282e);border:1px solid rgba(21,40,46,.12);border-radius:20px;box-shadow:0 18px 60px rgba(21,40,46,.22);padding:24px;font-family:"Plus Jakarta Sans",system-ui,sans-serif;transform:translateY(14px);opacity:0;transition:opacity .35s ease,transform .35s ease}',
    '.ck.in{transform:none;opacity:1}',
    '.ck h2{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:1.28rem;margin:0 0 8px;color:var(--teal,#17323A)}',
    '.ck p{margin:0 0 16px;font-size:.93rem;line-height:1.62;color:var(--muted,#5e6f72)}',
    '.ck a{color:var(--gold-ink,#9a7a26);text-decoration:underline;text-underline-offset:2px}',
    '.ck-acts{display:flex;flex-wrap:wrap;gap:10px}',
    '.ck-btn{font:inherit;font-size:.88rem;font-weight:600;cursor:pointer;border-radius:999px;padding:11px 20px;border:1px solid transparent;transition:background .25s ease,color .25s ease,border-color .25s ease}',
    '.ck-btn:focus-visible{outline:2px solid var(--gold,#F4C95D);outline-offset:2px}',
    // Accept and reject are the same size, weight and prominence. Only the
    // colour differs, and neither is styled to be the easy one.
    '.ck-btn.p{background:var(--teal,#17323A);color:var(--cream,#F7F3EA);border-color:var(--teal,#17323A)}',
    '.ck-btn.p:hover{background:var(--teal-700,#21454f)}',
    '.ck-btn.s{background:transparent;color:var(--teal,#17323A);border-color:rgba(21,40,46,.28)}',
    '.ck-btn.s:hover{border-color:var(--teal,#17323A)}',
    '.ck-btn.t{background:transparent;color:var(--muted,#5e6f72);padding:11px 8px;text-decoration:underline;text-underline-offset:3px}',
    '.ck-btn.t:hover{color:var(--teal,#17323A)}',
    '.ck-cats{margin:0 0 18px;border-top:1px solid rgba(21,40,46,.1)}',
    '.ck-cat{border-bottom:1px solid rgba(21,40,46,.1);padding:14px 0;display:grid;grid-template-columns:1fr auto;gap:6px 16px;align-items:start}',
    '.ck-cat h3{margin:0;font-size:.95rem;font-weight:700;color:var(--teal,#17323A)}',
    '.ck-cat p{margin:4px 0 0;font-size:.85rem;line-height:1.55}',
    '.ck-cat .ck-fixed{font-size:.78rem;font-weight:600;color:var(--muted,#5e6f72);white-space:nowrap;padding-top:2px}',
    '.ck-sw{position:relative;width:44px;height:25px;flex:none}',
    '.ck-sw input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
    '.ck-sw span{position:absolute;inset:0;border-radius:999px;background:rgba(21,40,46,.22);transition:background .25s ease;pointer-events:none}',
    '.ck-sw span::after{content:"";position:absolute;top:3px;left:3px;width:19px;height:19px;border-radius:50%;background:#fff;transition:transform .25s ease}',
    '.ck-sw input:checked+span{background:var(--ok,#2c7a57)}',
    '.ck-sw input:checked+span::after{transform:translateX(19px)}',
    '.ck-sw input:focus-visible+span{outline:2px solid var(--gold,#F4C95D);outline-offset:2px}',
    '@media(max-width:560px){.ck{padding:20px}.ck-acts{flex-direction:column}.ck-btn{width:100%}}',
    '@media(prefers-reduced-motion:reduce){.ck,.ck-scrim{transition:none}}',
  ].join("");

  function injectCSS() {
    if (document.getElementById("ck-css")) return;
    var s = document.createElement("style");
    s.id = "ck-css";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---- UI --------------------------------------------------------------- */

  var COPY = {
    functional: ["Functional", "Remembers optional preferences and the partner link you arrived through, so the right operator is credited if you book."],
    analytics: ["Analytics", "Google Analytics, so we can see which pages people use and how travellers find us. Never used to identify you."],
  };

  var node = null, scrim = null, lastFocus = null;

  function close() {
    if (!node) return;
    node.classList.remove("in");
    if (scrim) scrim.classList.remove("in");
    var n = node, s = scrim;
    node = null; scrim = null;
    setTimeout(function () { if (n) n.remove(); if (s) s.remove(); }, 320);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function save(choice) { write(choice); close(); }

  function onKey(e) { if (e.key === "Escape" && node) close(); }

  function render(prefs) {
    injectCSS();
    if (node) node.remove();
    if (scrim) scrim.remove();
    lastFocus = document.activeElement;

    if (prefs) {
      scrim = document.createElement("div");
      scrim.className = "ck-scrim";
      scrim.onclick = close;
      document.body.appendChild(scrim);
    }

    node = document.createElement("div");
    node.className = "ck";
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", prefs ? "true" : "false");
    node.setAttribute("aria-labelledby", "ck-title");

    var h = document.createElement("h2");
    h.id = "ck-title";
    h.textContent = prefs ? "Choose your cookies" : "Your cookie choices";
    node.appendChild(h);

    var p = document.createElement("p");
    if (prefs) {
      p.textContent = "Strictly necessary cookies keep the site secure and let reservations work, so they are always on. Everything else is yours to decide.";
    } else {
      p.innerHTML = 'We use necessary cookies to keep Sawa secure and make reservations work. With your permission we also use analytics cookies, and a functional one that credits the partner who referred you. Read our <a href="/cookies">Cookie Policy</a>.';
    }
    node.appendChild(p);

    var boxes = {};
    if (prefs) {
      var cats = document.createElement("div");
      cats.className = "ck-cats";

      cats.appendChild(catRow("Strictly necessary", "Security, sign-in, reservations and remembering these choices. The site cannot work without them.", null));
      CATEGORIES.forEach(function (c) {
        var row = catRow(COPY[c][0], COPY[c][1], c);
        boxes[c] = row.querySelector("input");
        cats.appendChild(row);
      });
      node.appendChild(cats);
    }

    var acts = document.createElement("div");
    acts.className = "ck-acts";

    if (prefs) {
      acts.appendChild(btn("Save choices", "p", function () {
        save({ functional: boxes.functional.checked, analytics: boxes.analytics.checked });
      }));
    }
    acts.appendChild(btn("Accept all", prefs ? "s" : "p", function () { save({ functional: true, analytics: true }); }));
    acts.appendChild(btn("Reject optional", "s", function () { save({ functional: false, analytics: false }); }));
    if (!prefs) acts.appendChild(btn("Manage choices", "t", function () { render(true); }));

    node.appendChild(acts);
    document.body.appendChild(node);

    // Nothing is pre-ticked beyond what was already chosen; an undecided
    // visitor sees every optional category off.
    if (prefs && state) {
      CATEGORIES.forEach(function (c) { boxes[c].checked = !!state[c]; });
    }

    requestAnimationFrame(function () {
      node.classList.add("in");
      if (scrim) scrim.classList.add("in");
      var first = node.querySelector("input,button");
      if (prefs && first) first.focus();
    });
  }

  function catRow(title, desc, category) {
    var row = document.createElement("div");
    row.className = "ck-cat";

    var text = document.createElement("div");
    var h3 = document.createElement("h3");
    h3.textContent = title;
    var d = document.createElement("p");
    d.textContent = desc;
    text.appendChild(h3);
    text.appendChild(d);
    row.appendChild(text);

    if (!category) {
      var fixed = document.createElement("div");
      fixed.className = "ck-fixed";
      fixed.textContent = "Always active";
      row.appendChild(fixed);
    } else {
      var sw = document.createElement("label");
      sw.className = "ck-sw";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("aria-label", title);
      var track = document.createElement("span");
      sw.appendChild(input);
      sw.appendChild(track);
      row.appendChild(sw);
    }
    return row;
  }

  function btn(label, kind, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ck-btn " + kind;
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  /* ---- footer entry point ----------------------------------------------- */

  // Injected rather than written into twenty footers, so it can never appear on
  // a page where the script that makes it work did not load.
  function addFooterLink() {
    var cols = document.querySelectorAll("footer .fcol, .sfooter .fcol");
    for (var i = 0; i < cols.length; i++) {
      var head = cols[i].querySelector("h4");
      if (!head || head.textContent.trim() !== "Company") continue;
      if (cols[i].querySelector(".ck-link")) return;
      var a = document.createElement("a");
      a.href = "#";
      a.className = "ck-link";
      a.textContent = "Cookie settings";
      a.onclick = function (e) { e.preventDefault(); render(true); };
      cols[i].appendChild(a);
      return;
    }
  }

  function start() {
    document.addEventListener("keydown", onKey);
    addFooterLink();
    if (!state) render(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // The SPA swaps its footer out on navigation, so the link is re-added when a
  // route renders one without it.
  window.addEventListener("popstate", function () { setTimeout(addFooterLink, 60); });
})();
