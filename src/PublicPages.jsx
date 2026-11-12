// The public pages outside the catalogue: partners, tours list, how it works, about, contact, FAQ, legal, booking lookup, 404, and the blog
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import React, { useState, useEffect } from "react";
import {
  ShieldCheck,
  Search,
  MapPin,
  Users,
  BadgeCheck,
  CalendarDays,
  MessageCircle,
  Mail,
  Clock3,
  ArrowRight,
  ChevronDown,
  Ticket,
  Newspaper,
  ArrowLeft,
  Check,
} from "lucide-react";
import { isPackage } from "../shared/booking-policy.js";
import { tourSlug } from "../server/slug.js";
import { seatsTotal, isGoAheadDeparture } from "../shared/departure-state.js";
import { GROUP_MAX_WORD } from "../shared/group-size.js";
import { CURRENCY_SYMBOL } from "../shared/currency.js";
import { PageHead, SpaLink, SawaMark, PageCTA, CardLink } from "./SiteChrome.jsx";
import { formatDate, SUPPORT_AVAILABILITY, BOOTSTRAP_TIMEOUT_MS } from "./tour-helpers.jsx";
import { PackageCard, TourCard } from "./TourCards.jsx";
import { API_BASE } from "./supabaseClient";
import { keepLinksOutOfFrame } from "./embed-links.js";
import { BookingPayAtGoAhead } from "./PayAtGoAheadPublic.jsx";
import { JoinGroupLink } from "./GroupBooking.jsx";
import { ResendConfirmation } from "./BookingConfirmation.jsx";
import { toDate } from "./dates.js";
import { readInlineData } from "./inline-data.js";
import { sizedImage } from "../shared/image-size.js";

function PublicRoute({ page, path, navigate, customerCalendars, customerSummary, cityStats, selectedCity, setSelectedCity, operatorsByProduct }) {
  switch (page) {
    case "tours":
      return (
        <ToursPage
          navigate={navigate}
          customerCalendars={customerCalendars}
          cityStats={cityStats}
          selectedCity={selectedCity}
          setSelectedCity={setSelectedCity}
        />
      );
    case "how": return <HowItWorksPage navigate={navigate} customerSummary={customerSummary} />;
    case "about": return <AboutPage navigate={navigate} customerSummary={customerSummary} />;
    case "contact": return <ContactPage navigate={navigate} />;
    case "faq": return <FaqPage navigate={navigate} />;
    case "privacy": return <LegalPage kind="privacy" navigate={navigate} />;
    case "terms": return <LegalPage kind="terms" navigate={navigate} />;
    case "booking": return <BookingLookupPage navigate={navigate} path={path} />;
    case "blog": return <BlogIndexPage navigate={navigate} />;
    case "blogpost": return <BlogPostPage key={path} navigate={navigate} slug={decodeURIComponent((path.match(/^\/blog\/([^/]+)/) || [])[1] || "")} />;
    case "partners": return <PartnersPage navigate={navigate} operatorsByProduct={operatorsByProduct} customerCalendars={customerCalendars} />;
    default: return <NotFoundPage navigate={navigate} />;
  }
}

// ---- /partners : the operator directory ----
// Renders from operatorsByProduct — the publicOperator() whitelist keyed by
// agency id — joined client-side to the public catalogue for each partner's
// itineraries. The crawler body for this route (server/seo.js) states the same
// facts from the same whitelist; neither surface knows more than the other,
// and licence numbers and contacts are in neither.
//
// "Verified by Sawa" renders only from the verification state: a record makes
// a company a partner; verification is a separate claim with its own date, and
// an unverified partner is listed by name without the line (029's rule).
function PartnersPage({ navigate, operatorsByProduct = {}, customerCalendars = [] }) {
  const partners = Object.entries(operatorsByProduct)
    .map(([id, op]) => ({ ...op, itineraries: customerCalendars.filter((p) => p.agencyId === id) }))
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="Partners"
        title="The companies that operate Sawa departures."
        lead="Sawa pools travelers into shared departures; the trips themselves are run by Egyptian travel companies licensed by the Ministry of Tourism and Antiquities and registered with ETAA. Where Sawa has completed its verification of a partner's records, that is shown with its date."
      />
      <section className="partners-list reveal in">
        {partners.length === 0 ? (
          <article>
            <p>No operating partner is listed here yet. Every Sawa departure is still run by a licensed Egyptian travel company — the company responsible for a specific trip is named on that trip's page.</p>
          </article>
        ) : partners.map((p) => (
          <article key={p.name}>
            <h2>{p.name}</h2>
            {p.verified && (
              <p className="partner-verified"><ShieldCheck size={14} />Verified by Sawa{p.verifiedAt ? ` · ${formatDate(p.verifiedAt, { alwaysYear: true })}` : ""}</p>
            )}
            <p>
              {p.licensedSince
                ? `Licensed by the Egyptian Ministry of Tourism and Antiquities since ${p.licensedSince}. `
                : "Licensed by the Egyptian Ministry of Tourism and Antiquities. "}
              {p.etaaUrl && (
                <>A member of the <a href={p.etaaUrl} target="_blank" rel="noopener noreferrer">Egyptian Travel Agents Association</a>. </>
              )}
              This is a company responsible for delivering Sawa departures.
            </p>
            {p.itineraries.length > 0 && (
              <p>
                {"Operates "}{p.itineraries.length === 1 ? "one itinerary" : `${p.itineraries.length} itineraries`}{" on Sawa: "}
                {p.itineraries.map((t, i) => (
                  <span key={t.id}>{i > 0 ? ", " : ""}<SpaLink navigate={navigate} to={`/${isPackage(t) ? "package" : "tour"}/${tourSlug(t)}`}>{t.title}</SpaLink></span>
                ))}.
              </p>
            )}
          </article>
        ))}
      </section>
      <section className="reveal in">
        <p className="partners-note">The directory grows as operators join — an Egyptian travel company can <a href="/verify">apply to list with Sawa</a>.</p>
      </section>
    </div>
  );
}

// ---- /tours : full catalog ----
function ToursPage({ navigate, customerCalendars, cityStats, selectedCity, setSelectedCity }) {
  const [view, setView] = useState("all");
  const [q, setQ] = useState("");
  const cities = ["All cities", ...cityStats.map((c) => c.name)];

  let items = customerCalendars.filter((p) => selectedCity === "All cities" || p.city === selectedCity);
  if (view === "day_tours") items = items.filter((p) => !isPackage(p));
  if (view === "packages") items = items.filter((p) => isPackage(p));
  if (q.trim()) {
    const t = q.trim().toLowerCase();
    items = items.filter((p) => `${p.title} ${p.city} ${(p.cities || []).join(" ")}`.toLowerCase().includes(t));
  }
  items = items.slice().sort((a, b) => {
    const al = a.dates[0], bl = b.dates[0];
    const as = al ? seatsTotal(al.pledges) : 0, bs = bl ? seatsTotal(bl.pledges) : 0;
    const ac = al && isGoAheadDeparture(al) ? 1 : 0, bc = bl && isGoAheadDeparture(bl) ? 1 : 0;
    return bc - ac || bs - as;
  });

  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="Itineraries"
        title="Every Sawa itinerary, on one page."
        // The ceiling is the universal promise and is rendered from the
        // constant; the threshold is per product and is never stated here,
        // because it is not the same number on every itinerary. Each card and
        // each date carries its own.
        lead={`Every itinerary Sawa runs is operated by an Egyptian travel company licensed by the Ministry of Tourism and registered with ETAA. Open one to join a forming date or start your own. Each date shows exactly how many travelers it needs to confirm — that moment is the GoAhead — and no Sawa group ever goes above ${GROUP_MAX_WORD}. You pay nothing until your date confirms.`}
      />

      <div className="tours-toolbar reveal in">
        {/* Toggle buttons: which city is active was conveyed by colour alone,
            so a screen-reader user heard a row of city names with no way to
            tell which filter was on. aria-pressed is the state that matches a
            toggle (aria-selected belongs to tabs/options). */}
        <div className="tours-cities" role="group" aria-label="Filter tours by city">
          {cities.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={selectedCity === c}
              className={selectedCity === c ? "chip on" : "chip"}
              onClick={() => setSelectedCity(c)}
            >
              {c === "All cities" ? "All Egypt" : c}
            </button>
          ))}
        </div>
        <div className="tours-toolbar-right">
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={view === "all"} className={view === "all" ? "on" : ""} onClick={() => setView("all")}>All</button>
            <button role="tab" aria-selected={view === "day_tours"} className={view === "day_tours" ? "on" : ""} onClick={() => setView("day_tours")}>Day tours</button>
            <button role="tab" aria-selected={view === "packages"} className={view === "packages" ? "on" : ""} onClick={() => setView("packages")}>Packages</button>
          </div>
          <label className="tours-search">
            <Search size={16} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tours…" aria-label="Search tours" />
          </label>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="page-empty reveal in">
          <MapPin size={26} />
          <strong>No tours match that yet.</strong>
          <p>Try another city or clear your search.</p>
          <button className="btn-pill" onClick={() => { setView("all"); setQ(""); setSelectedCity("All cities"); }}>Clear filters</button>
        </div>
      ) : (
        <div className="departure-modules tours-grid reveal in">
          {items.map((p) => (
            isPackage(p)
              ? <PackageCard key={p.id} navigate={navigate} product={p} />
              : <TourCard key={p.id} navigate={navigate} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- /how-it-works ----
function HowItWorksPage({ navigate, customerSummary }) {
  const steps = [
    { n: "01", t: "Hold a seat, free", d: "Pick a date and reserve your spot with no card and no deposit. You're simply joining the group that's forming for that day." },
    { n: "02", t: "The group fills", d: "As more travelers book the same date, it moves toward GoAhead. The shared cost of the guide and vehicle is split across everyone, so the price stays fair." },
    { n: "03", t: "It runs — confirmed.", d: "Once the minimum number of travelers is reached, we confirm the guide and transport and send you a secure payment link for your deposit. If a date never fills, you pay nothing." },
  ];
  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="How Sawa works"
        title="Your seat is free until the trip is real."
        lead="“Sawa” means together. We pool small bookings from different travelers into one shared group, so day tours and packages actually run — and you never pay for a date that isn't confirmed."
      />

      <div className="how2-steps reveal in">
        {steps.map((s) => (
          <article className="how2-step" key={s.n}>
            <span className="how2-num">{s.n}</span>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
          </article>
        ))}
      </div>

      <section className="how2-goahead reveal in">
        <div className="how2-goahead-mark"><SawaMark size={64} /></div>
        <div>
          <p className="page-eyebrow">The gold dot</p>
          <h2>GoAhead means your tour is confirmed.</h2>
          <p>When a date reaches its minimum travelers, it turns GoAhead — the guide and vehicle are booked and the departure is locked in. Until then, your seat is just a free hold. No surprises, no last-minute cancellations after you've paid.</p>
        </div>
      </section>

      <section className="how2-trust reveal in">
        <div className="how2-trust-item"><Users size={20} /><div><strong>Small groups</strong><span>Shared, never crowded — a real guide, not a mega-bus.</span></div></div>
        <div className="how2-trust-item"><ShieldCheck size={20} /><div><strong>Ministry-licensed operators</strong><span>Licensed Egyptian guides and checked vehicles on every trip.</span></div></div>
        <div className="how2-trust-item"><BadgeCheck size={20} /><div><strong>No payment until confirmed</strong><span>You're only charged once the date is confirmed to run.</span></div></div>
      </section>

      <PageCTA navigate={navigate} note={`${customerSummary?.goAheadDates ?? 0} groups going ahead right now`} />
    </div>
  );
}

// ---- /about ----
function AboutPage({ navigate, customerSummary }) {
  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="About Sawa"
        title="Shared departures, confirmed together."
        lead="Sawa is a Cairo-based shared-tour platform. We connect independent travelers heading the same way on the same day, so small bookings become real, confirmed group departures across Egypt."
      />

      <section className="about-lead reveal in">
        <div className="about-lead-text">
          <h2>Why we built it</h2>
          <p>Booking a day tour in Egypt usually means two bad options: pay a premium for a private car, or book a cheap group tour that quietly gets canceled when not enough people sign up. Sawa fixes the second problem. By pooling bookings from multiple agencies and travelers into one shared group, a date only needs a handful of people to be confirmed — and everyone shares a fair price.</p>
          <p>You hold your seat for free and watch the group fill in real time. The moment it reaches GoAhead, the guide and vehicle are locked in. You only pay when the trip is real.</p>
        </div>
        <aside className="about-stats">
          <div><strong>{customerSummary?.tours ?? 0}</strong><span>tours &amp; packages</span></div>
          <div><strong>{customerSummary?.goAheadDates ?? 0}</strong><span>going ahead now</span></div>
          <div><strong>3</strong><span>cities: Cairo, Luxor, Aswan</span></div>
        </aside>
      </section>

      <section className="about-pillars reveal in">
        <article><Users size={22} /><h3>Small groups</h3><p>Shared, never crowded. A proper guide and a comfortable vehicle, not a packed coach.</p></article>
        <article><ShieldCheck size={22} /><h3>Ministry-licensed operators</h3><p>Every departure runs with licensed Egyptian guides and inspected transport.</p></article>
        <article><CalendarDays size={22} /><h3>Real departures</h3><p>Dates are confirmed before you pay — what you book is what actually runs.</p></article>
      </section>

      <PageCTA navigate={navigate} />
    </div>
  );
}

// ---- /contact ----
function ContactPage({ navigate }) {
  const [form, setForm] = useState({ name: "", email: "", message: "", consent: false, website: "" });
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  // Sent by the server (POST /api/public/contact → hello@sawa.tours and the
  // team's CRM), the same route as site/contact.html. It used to be a mailto:
  // link, which did nothing for a visitor without an email app — and said
  // "on its way" regardless.
  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/public/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, role: "Traveler" }),
      });
      const b = await r.json().catch(() => ({}));
      if (r.ok && b.ok) setSent(true);
      else setError(b.error || "Sorry — your message didn't send.");
    } catch {
      setError("Sorry — we couldn't reach our server.");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="Talk to us"
        title={SUPPORT_AVAILABILITY}
        lead="Questions about a date, a pickup, or a private group? Message us on WhatsApp for the fastest answer, or send a note below."
      />
      <div className="contact-grid reveal in">
        <div className="contact-methods">
          <a className="contact-card" href="https://wa.me/201092847613" target="_blank" rel="noreferrer">
            <MessageCircle size={20} />
            <div><strong>WhatsApp</strong><span>+20 109 284 7613</span></div>
          </a>
          <a className="contact-card" href="mailto:hello@sawa.tours">
            <Mail size={20} />
            <div><strong>Email</strong><span>hello@sawa.tours</span></div>
          </a>
          <div className="contact-card static">
            <Clock3 size={20} />
            <div><strong>Support</strong><span>{SUPPORT_AVAILABILITY}</span></div>
          </div>
          <div className="contact-card static">
            <MapPin size={20} />
            <div><strong>Based in</strong><span>Cairo, Egypt · licensed operator</span></div>
          </div>
        </div>

        <form className="contact-form" onSubmit={submit}>
          {sent ? (
            <div className="contact-sent">
              <BadgeCheck size={28} />
              <strong>Thank you — your message has been sent.</strong>
              <p>{SUPPORT_AVAILABILITY} — for anything urgent that is the fastest route. Email replies follow as soon as we can.</p>
            </div>
          ) : (
            <>
              <label className="field"><span>Your name</span><input value={form.name} onChange={set("name")} required autoComplete="name" placeholder="Full name" /></label>
              <label className="field"><span>Email</span><input type="email" value={form.email} onChange={set("email")} required autoComplete="email" placeholder="you@email.com" /></label>
              <label className="field"><span>Message</span><textarea value={form.message} onChange={set("message")} required maxLength={5000} rows={5} placeholder="Which tour or date are you asking about?" /></label>
              <div aria-hidden="true" style={{ position: "absolute", left: -10000, width: 1, height: 1, overflow: "hidden" }}>
                <label>Website<input value={form.website} onChange={set("website")} tabIndex={-1} autoComplete="off" /></label>
              </div>
              <label className="consent"><input type="checkbox" checked={form.consent} onChange={set("consent")} required /><span>I agree to be contacted about my enquiry.</span></label>
              {error && (
                <p className="contact-error" role="alert">
                  {error.replace(/\s*[^.]*WhatsApp[^.]*\.?\s*$/, "") || "Sorry — your message didn't send."}{" "}
                  Please try again, or message us on <a href="https://wa.me/201092847613" target="_blank" rel="noreferrer">WhatsApp (+20 109 284 7613)</a>.
                </p>
              )}
              <button className="btn-pill primary" type="submit" disabled={sending}>{sending ? "Sending…" : "Send message"} <ArrowRight size={16} /></button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

// ---- /faq ----
const FAQ_GROUPS = [
  {
    title: "Booking & payment",
    items: [
      { q: "Do I pay when I book?", a: "No. Holding a seat is completely free. You only pay a deposit once your date reaches GoAhead and is confirmed to run." },
      { q: "What happens if the tour doesn't fill?", a: "If a date never reaches the minimum number of travelers, it simply doesn't run and you're charged nothing. We'll let you know and help you move to another date." },
      { q: "How much is the deposit?", a: "It varies by tour, but it's a small percentage of the total shown clearly before you confirm. The balance is settled per the tour's terms." },
    ],
  },
  {
    title: "GoAhead & how it works",
    items: [
      { q: "What does GoAhead mean?", a: "GoAhead means a date has reached its own confirmation number, so the guide and vehicle are booked and the departure is confirmed to run." },
      { q: "Can a confirmed tour still be canceled?", a: "Once a date is GoAhead we don't cancel it for low numbers. In rare cases of safety or weather, we'll rebook or refund you." },
    ],
  },
  {
    title: "On the day",
    items: [
      { q: "Where do we meet?", a: "Each tour lists its exact meeting point and time — for example the Egyptian Museum in Tahrir for Cairo tours. You'll get the details with your confirmation." },
      { q: "Are the groups large?", a: "No. Sawa runs small shared groups with a licensed guide — enough people to make the date work, never a crowded coach." },
    ],
  },
  {
    title: "Cancellations",
    items: [
      { q: "Can I cancel my booking?", a: "Yes. Before GoAhead you can cancel free, any time, from your booking page or by email — nothing has been charged. After GoAhead our cancellation schedule applies; it's in section 13 of the Terms, and an operator's own schedule applies only where it was disclosed before you reserved." },
    ],
  },
];

function FaqPage({ navigate }) {
  return (
    <div className="page-wrap">
      <PageHead eyebrow="FAQ" title="Questions, answered." lead="Everything about holding a seat, GoAhead, and what happens on the day. Still stuck? Talk to us on WhatsApp." />
      <div className="faq-groups reveal in">
        {FAQ_GROUPS.map((g) => (
          <section className="faq-group" key={g.title}>
            <h2>{g.title}</h2>
            {g.items.map((it) => (
              <details className="faq-item" key={it.q}>
                <summary><span>{it.q}</span><ChevronDown size={18} /></summary>
                <p>{it.a}</p>
              </details>
            ))}
          </section>
        ))}
      </div>
      <PageCTA navigate={navigate} />
    </div>
  );
}

// ---- /privacy and /terms ----
function LegalPage({ kind, navigate }) {
  const updated = "June 2026";
  const content = kind === "privacy" ? PRIVACY_SECTIONS : TERMS_SECTIONS;
  const title = kind === "privacy" ? "Privacy Policy" : "Terms of Service";
  return (
    <div className="page-wrap legal-wrap">
      <PageHead eyebrow="Legal" title={title} lead={`Last updated ${updated}. This is a plain-language summary of how Sawa operates — please review with your own counsel before launch.`} />
      <article className="legal-body reveal in">
        {content.map((s) => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p.map((para, i) => <p key={i}>{para}</p>)}
          </section>
        ))}
        <p className="legal-contact">Questions about this policy? Email <a href="mailto:hello@sawa.tours">hello@sawa.tours</a>.</p>
      </article>
    </div>
  );
}

const PRIVACY_SECTIONS = [
  { h: "What we collect", p: ["When you hold a seat or book a tour, we collect the details you give us — your name, email, phone number, the travelers in your party, and the tour and date you choose.", "We also collect basic technical information such as your browser type and pages visited, to keep the service running and secure."] },
  { h: "How we use it", p: ["We use your information to confirm departures, contact you about your booking, take payment when a date is confirmed, and provide support. Agencies you book through can see the booking details needed to run your tour.", "We do not sell your personal information."] },
  { h: "Who sees it", p: ["Your booking details are shared only with the operating agency and our operations team, strictly to deliver your tour. Payment is handled by our payment provider; we don't store full card details."] },
  { h: "Your choices", p: ["You can ask us to access, correct, or delete your information at any time by emailing us. You can opt out of non-essential messages while still receiving booking updates."] },
  { h: "Data retention", p: ["We keep booking records for as long as needed to provide the service and meet legal and accounting obligations, then delete or anonymise them."] },
];

const TERMS_SECTIONS = [
  { h: "The Sawa model", p: ["Sawa pools bookings from multiple travelers and agencies into shared group departures. Holding a seat is free and does not guarantee the tour will run. A departure becomes confirmed (GoAhead) only when it reaches the minimum number of travelers."] },
  { h: "Bookings & payment", p: ["You pay nothing to hold a seat. Once a date reaches GoAhead, the deposit shown at booking becomes due to confirm your place. The remaining balance is payable per the individual tour's terms.", "Prices are shown per person and may vary with group size, accommodation tier, and room type for packages."] },
  { h: "Cancellations", p: ["You may release a free hold at any time before confirmation at no cost, from your booking page or by email. After a date is confirmed, the cancellation schedule in section 13 of our Terms applies — an operator's own schedule applies only where it was disclosed before you reserved. Sawa and its operators may cancel for reasons of safety, weather, or force majeure, in which case we will rebook or refund you."] },
  { h: "On the day", p: ["You are responsible for arriving at the listed meeting point at the stated time. Tours depart on schedule; missed departures due to late arrival are not refundable."] },
  { h: "Operators", p: ["Tours are delivered by licensed Egyptian operators. Sawa coordinates the shared booking; the operating agency is responsible for the conduct of the tour itself."] },
  { h: "Liability", p: ["To the extent permitted by law, Sawa's liability is limited to the amount you paid for the affected booking. Please ensure you have appropriate travel insurance."] },
];

// ---- /booking : look up a booking by code ----
// 043 — the payment part of a booking: the open Tab link to pay, or what has
// been received. Nothing is shown before anything is owed.
function BookingPayment({ payment }) {
  if (!payment || payment.stage === "not_due" || payment.stage === "cancelled") return null;
  const m = (n) => `${CURRENCY_SYMBOL}${Number(n || 0).toLocaleString()}`;
  const due = (iso) => new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo", timeZoneName: "short",
  }).format(new Date(iso));
  const what = { deposit: "deposit", balance: "balance", full: "payment" };
  return (
    <div className={`booking-pay ${payment.open?.overdue ? "is-late" : ""}`}>
      <div className="booking-pay-row">
        <span>Payment</span>
        <b>{payment.stage === "paid_in_full" ? "Paid in full" : `${m(payment.paid)} of ${m(payment.total)} paid`}</b>
      </div>
      {payment.open ? (
        <>
          <p>
            Your {what[payment.open.kind] || "payment"} of <b>{m(payment.open.amount)}</b> is due by {due(payment.open.dueAt)}
            {payment.open.overdue ? " — this is now overdue. Please pay as soon as you can, or reply to our email if something is wrong." : "."}
          </p>
          <a className="btn gold booking-pay-btn" href={payment.open.linkUrl} target="_blank" rel="noopener noreferrer">
            Pay {m(payment.open.amount)} securely
          </a>
          <small>Card payment through Tab, our payment provider.</small>
        </>
      ) : payment.stage === "paid_in_full" ? null : (
        <p>{payment.paid > 0 ? "Thank you — your deposit is in. We'll email the link for the rest before it's due." : "We'll email your payment link shortly."}</p>
      )}
    </div>
  );
}

// `embed`: the same lookup inside the partner widget (EmbedBooking below) —
// same state from the server, same cancel, drawn in the widget's frame with no
// navigation out of it. One component on purpose: a second copy of "what a
// traveller may do with a booking" is how the two would come to disagree.
function BookingLookupPage({ navigate, path = "", embed = false, initialCode = "", onBrowse = null }) {
  const initial = embed ? initialCode : decodeURIComponent((path.match(/^\/booking\/([^/]+)/) || [])[1] || "");
  const [code, setCode] = useState(initial);
  const [state, setState] = useState({ status: "idle", data: null, error: "" });
  // Two steps on purpose. This is the one destructive control a traveller can
  // reach from a link in an email, and a mail client that prefetches links must
  // not be able to release someone's seat — the confirm step is a POST that only
  // a person can trigger.
  const [confirming, setConfirming] = useState(false);
  const [cancelState, setCancelState] = useState({ busy: false, error: "" });

  async function cancelBooking() {
    const c = (state.data?.code || code).trim();
    if (!c) return;
    setCancelState({ busy: true, error: "" });
    try {
      const r = await fetch(`${API_BASE}/public/bookings/${encodeURIComponent(c)}/cancel`, { method: "POST" });
      if (!r.ok) {
        // The server's message is the useful one — it names the schedule that
        // applies past GoAhead and where to find it, which a generic failure
        // would hide behind "something went wrong".
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "We couldn't cancel that booking. Please contact us.");
      }
      setConfirming(false);
      setCancelState({ busy: false, error: "" });
      await lookup();               // re-read rather than guess the new state
    } catch (err) {
      setCancelState({ busy: false, error: err.message });
    }
  }

  async function lookup(e) {
    if (e) e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setState({ status: "loading", data: null, error: "" });
    try {
      const r = await fetch(`${API_BASE}/public/bookings/${encodeURIComponent(c)}`);
      if (r.status === 404) { setState({ status: "notfound", data: null, error: "" }); return; }
      if (!r.ok) throw new Error("Something went wrong. Please try again.");
      const j = await r.json();
      setState({ status: "found", data: j.booking, error: "" });
    } catch (err) {
      setState({ status: "error", data: null, error: err.message });
    }
  }

  useEffect(() => { if (initial) lookup(); /* eslint-disable-next-line */ }, []);

  const b = state.data;
  return (
    <div className={embed ? "eb-panel eb-booking" : "page-wrap"} onClickCapture={embed ? keepLinksOutOfFrame : undefined}>
      {embed
        ? <div className="eb-head"><strong className="eb-title">Your booking</strong><span className="eb-facts">Enter the booking code from your confirmation email to see your date, or to cancel.</span></div>
        : <PageHead eyebrow="Your booking" title="Check your departure." lead="Enter the booking code from your confirmation to see whether your date has reached GoAhead." />}
      <form className="booking-lookup reveal in" onSubmit={lookup}>
        <label className="field">
          <span>Booking code</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. SAWA-7K2QXM4T" />
        </label>
        <button className="btn-pill primary" type="submit" disabled={state.status === "loading"}>
          {state.status === "loading" ? "Checking…" : "Check status"} <Search size={16} />
        </button>
      </form>

      <div className="booking-result reveal in">
        {state.status === "notfound" && (
          embed
            ? <div className="page-empty"><Ticket size={26} /><strong>No booking found with that code.</strong><p>Double-check the code in your confirmation email.</p></div>
            : <div className="page-empty"><Ticket size={26} /><strong>No booking found with that code.</strong><p>Double-check the code in your confirmation email, or contact us.</p><SpaLink navigate={navigate} to="/contact" className="btn-pill">Contact us</SpaLink></div>
        )}
        {state.status === "error" && <div className="form-error">{state.error}</div>}
        {state.status === "found" && b && (
          <article className={`booking-card ${b.confirmed ? "is-go" : ""}`}>
            <div className="booking-card-status">
              <span className={`booking-badge ${b.statusTone}`}>{b.statusLabel}</span>
              <span className="booking-code">{b.code}</span>
            </div>
            <h2>{b.tourTitle}</h2>
            <div className="booking-meta">
              <div><CalendarDays size={16} /> {b.dateLabel}</div>
              <div><Users size={16} /> {b.seats} {b.seats === 1 ? "seat" : "seats"}</div>
              {b.city && <div><MapPin size={16} /> {b.city}</div>}
            </div>
            {/* LL3 — the seat count is a live figure. On a date that is not
                running it is not information, it is an invitation to keep
                waiting, so the server decides whether it is shown at all. */}
            {b.showProgress && (
              <div className="booking-progress">
                <div className="booking-progress-row"><span>{b.seatsBooked}/{b.goAhead} seats to confirm</span><b>{b.confirmed ? "GoAhead — confirmed" : "Still forming"}</b></div>
                <i><em style={{ width: `${Math.min(100, (b.seatsBooked / Math.max(1, b.goAhead)) * 100)}%` }} /></i>
              </div>
            )}
            {/* The note comes from the server, which is the only thing that
                knows the state. It used to be chosen here from `confirmed`
                alone, which is how a cancelled date came to read "the guide and
                transport are booked". */}
            <p className="booking-note">{b.note}</p>
            <BookingPayment payment={b.payment} />
            {b.payAtGoAhead && <BookingPayAtGoAhead code={b.code} view={b.payAtGoAhead} onChanged={() => lookup()} />}
            {b.group && <JoinGroupLink code={b.code} group={b.group} />}
            {b.confirmation?.state === "unconfirmed" && <ResendConfirmation code={b.code} resendsLeft={b.confirmation.resendsLeft} />}
            {/* Whether this is offered at all comes from the server (canCancel),
                for the same reason the note does: only it knows the state, and
                a page that decided for itself is how a cancelled date came to
                read "the guide and transport are booked". */}
            {b.canCancel && (
              <div className="booking-cancel">
                {!confirming ? (
                  <button type="button" className="btn-pill" onClick={() => setConfirming(true)}>
                    Cancel this booking
                  </button>
                ) : (
                  <>
                    <p className="booking-cancel-ask">
                      Release {b.seats === 1 ? "your seat" : `all ${b.seats} seats`} on this date? Nothing was
                      charged, so there is nothing to refund — and you can book again while places remain.
                    </p>
                    <div className="booking-cancel-actions">
                      <button type="button" className="btn-pill primary" disabled={cancelState.busy} onClick={cancelBooking}>
                        {cancelState.busy ? "Canceling…" : "Yes, cancel my booking"}
                      </button>
                      <button type="button" className="btn-pill" disabled={cancelState.busy} onClick={() => setConfirming(false)}>
                        Keep my seat
                      </button>
                    </div>
                  </>
                )}
                {cancelState.error && <div className="form-error" role="alert">{cancelState.error}</div>}
              </div>
            )}
            {b.state === "date_cancelled" && b.routePath && (embed
              ? onBrowse && <button type="button" className="btn-pill primary" onClick={onBrowse}>See other dates <ArrowRight size={16} /></button>
              : (
                <SpaLink navigate={navigate} to={b.routePath} className="btn-pill primary">
                  See other dates on this route <ArrowRight size={16} />
                </SpaLink>
              ))}
          </article>
        )}
      </div>
    </div>
  );
}

// ---- 404 ----
function NotFoundPage({ navigate }) {
  return (
    <div className="page-wrap page-404">
      <div className="reveal in">
        <SawaMark size={56} />
        <h1>This page wandered off.</h1>
        <p>The page you're looking for doesn't exist — but plenty of tours do.</p>
        {/* These two go somewhere, so they are links, not buttons — the one
            page where a visitor is most likely to want a new tab or to check
            where a control leads before following it. */}
        <div className="page-404-actions">
          <SpaLink navigate={navigate} to="/itineraries" className="btn-pill primary">Browse itineraries <ArrowRight size={16} /></SpaLink>
          <SpaLink navigate={navigate} to="/" className="btn-pill">Back home</SpaLink>
        </div>
      </div>
    </div>
  );
}

// E01 — write a route's head facts (from /api/public/route-head) into the
// document, updating the tags the server rendered rather than adding copies.
function setHeadTag(attr, key, content) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute("content", content || "");
}
function applyRouteHead(m) {
  if (!m?.title) return;
  document.title = m.title;
  setHeadTag("name", "description", m.description);
  setHeadTag("name", "robots", m.noindex ? "noindex,nofollow" : "index,follow");
  setHeadTag("property", "og:title", m.title);
  setHeadTag("property", "og:description", m.description);
  setHeadTag("property", "og:url", m.canonical);
  setHeadTag("name", "twitter:title", m.title);
  setHeadTag("name", "twitter:description", m.description);
  let link = document.head.querySelector('link[rel="canonical"]');
  if (!link) { link = document.createElement("link"); link.setAttribute("rel", "canonical"); document.head.appendChild(link); }
  link.setAttribute("href", m.canonical);
}

// ---- Blog: SEO + GEO meta injection ----
function upsertMeta(attr, key, content) {
  if (!content) return;
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute("content", content);
  el.setAttribute("data-blog-meta", "1");
}
function setCanonical(href) {
  if (!href) return;
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) { el = document.createElement("link"); el.setAttribute("rel", "canonical"); document.head.appendChild(el); }
  el.setAttribute("href", href);
  el.setAttribute("data-blog-meta", "1");
}
function abs(u) { return u && !u.startsWith("http") ? window.location.origin + u : u; }
function applyPostMeta(p) {
  const title = p.metaTitle || p.title;
  const desc = p.metaDescription || p.excerpt || p.tldr || "";
  const url = p.canonicalUrl || `${window.location.origin}/blog/${p.slug}`;
  const img = abs(p.ogImage || p.coverImage || "");
  document.title = `${title} — Sawa Tours`;
  upsertMeta("name", "description", desc);
  if (p.keywords?.length) upsertMeta("name", "keywords", p.keywords.join(", "));
  upsertMeta("name", "robots", p.noindex ? "noindex,nofollow" : "index,follow");
  upsertMeta("name", "author", p.author || "Sawa Tours");
  setCanonical(url);
  upsertMeta("property", "og:type", "article");
  upsertMeta("property", "og:title", title);
  upsertMeta("property", "og:description", desc);
  upsertMeta("property", "og:url", url);
  if (img) upsertMeta("property", "og:image", img);
  upsertMeta("name", "twitter:card", img ? "summary_large_image" : "summary");
  upsertMeta("name", "twitter:title", title);
  upsertMeta("name", "twitter:description", desc);
  if (p.geoRegion) upsertMeta("name", "geo.region", p.geoRegion);
  if (p.geoPlace) upsertMeta("name", "geo.placename", p.geoPlace);
  if (p.geoLat && p.geoLng) { upsertMeta("name", "geo.position", `${p.geoLat};${p.geoLng}`); upsertMeta("name", "ICBM", `${p.geoLat}, ${p.geoLng}`); }
  const ld = [{
    "@context": "https://schema.org", "@type": "Article", headline: title, description: desc,
    image: img ? [img] : undefined, author: { "@type": "Person", name: p.author || "Sawa Tours", description: p.authorCredentials || undefined },
    publisher: { "@type": "Organization", name: "Sawa Tours" }, datePublished: p.publishedAt || undefined, mainEntityOfPage: url,
  }];
  if (p.faq?.length) ld.push({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: p.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) });
  if (p.geoPlace && p.geoLat && p.geoLng) ld.push({ "@context": "https://schema.org", "@type": "Place", name: p.geoPlace, geo: { "@type": "GeoCoordinates", latitude: p.geoLat, longitude: p.geoLng } });
  let s = document.getElementById("blog-jsonld");
  if (!s) { s = document.createElement("script"); s.id = "blog-jsonld"; s.type = "application/ld+json"; document.head.appendChild(s); }
  s.textContent = JSON.stringify(ld);
}
function resetMeta() {
  document.title = "Sawa Tours — Shared departures, confirmed together";
  document.querySelectorAll("[data-blog-meta]").forEach((e) => e.remove());
  const s = document.getElementById("blog-jsonld");
  if (s) s.remove();
}
const blogDate = (d) => (d ? new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric" }).format(toDate(d)) : "");

// ---- /blog : listing ----
function BlogIndexPage({ navigate }) {
  const [state, setState] = useState({ status: "loading", posts: [] });
  useEffect(() => {
    document.title = "Blog — Sawa Tours";
    let alive = true;
    fetch(`${API_BASE}/blog`).then((r) => (r.ok ? r.json() : Promise.reject(r))).then((j) => { if (alive) setState({ status: "done", posts: j.posts || [] }); })
      .catch(() => alive && setState({ status: "error", posts: [] }));
    return () => { alive = false; };
  }, []);
  return (
    <div className="page-wrap">
      <PageHead eyebrow="The journal" title="Notes from the Nile." lead="Guides, history, and practical tips for seeing Egypt the shared way — written by the people who run the tours." />
      {state.status === "loading" ? (
        <div className="blog-grid">{[0, 1, 2].map((i) => <div className="blog-skel" key={i} />)}</div>
      ) : state.posts.length === 0 ? (
        <div className="page-empty"><Newspaper size={26} /><strong>No articles yet.</strong><p>Check back soon for stories from across Egypt.</p></div>
      ) : (
        <div className="blog-grid reveal in">
          {state.posts.map((p) => (
            // The card was an <article> with only an onClick: not focusable, not
            // announced as interactive, invisible to crawlers, and no
            // middle-click / open-in-new-tab. The title is now a real anchor —
            // that carries the semantics — stretched over the whole card, so
            // the card-level onClick is no longer needed to keep it clickable.
            <article className="blog-card" key={p.id}>
              <div className="blog-card-media" style={p.coverImage ? { backgroundImage: `url(${sizedImage(p.coverImage, 800)})` } : undefined}>
                {!p.coverImage && <Newspaper size={26} />}
              </div>
              <div className="blog-card-body">
                {p.tags?.[0] && <span className="blog-card-tag">{p.tags[0]}</span>}
                <h3>
                  <CardLink navigate={navigate} to={`/blog/${p.slug}`} label={`Read: ${p.title}`}>
                    {p.title}
                  </CardLink>
                </h3>
                {p.excerpt && <p>{p.excerpt}</p>}
                <div className="blog-card-meta">{p.author || "Sawa Tours"}{p.publishedAt ? ` · ${blogDate(p.publishedAt)}` : ""}</div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- /blog/:slug : article ----
function BlogPostPage({ navigate, slug }) {
  const [state, setState] = useState(() => {
    const post = readInlineData("sawa-blog-post");
    return post?.slug === slug && post.status === "published" && typeof post.bodyHtml === "string"
      ? { status: "done", post }
      : { status: "loading", post: null };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
    if (state.post) applyPostMeta(state.post);
    fetch(`${API_BASE}/blog/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "nf" : "err"))))
      .then((j) => {
        if (!j.post || j.post.slug !== slug || typeof j.post.bodyHtml !== "string") throw new Error("err");
        if (alive) { setState({ status: "done", post: j.post }); applyPostMeta(j.post); }
      })
      .catch((error) => {
        if (!alive) return;
        // A blocked request, timeout or 5xx is not evidence the post vanished.
        // Keep the server snapshot on refresh failure; only a real 404 is nf.
        setState((current) => error.message === "nf"
          ? { status: "not-found", post: null }
          : current.post ? current : { status: "error", post: null });
      })
      .finally(() => clearTimeout(timeout));
    return () => { alive = false; controller.abort(); clearTimeout(timeout); resetMeta(); };
  }, [slug, attempt]);

  if (state.status === "loading") return <div className="page-wrap"><div className="blog-post-skel" /></div>;
  if (state.status === "not-found") return <NotFoundPage navigate={navigate} />;
  if (state.status === "error") return (
    <div className="page-wrap"><div className="page-empty" role="alert">
      <strong>We couldn't load this article.</strong>
      <p>Please try again in a moment.</p>
      <button className="btn-pill primary" onClick={() => {
        setState({ status: "loading", post: null });
        setAttempt((n) => n + 1);
      }}>Try again</button>
    </div></div>
  );
  const p = state.post;
  const takeaways = (p.keyTakeaways || []).filter(Boolean);
  const faq = (p.faq || []).filter((f) => f.q);
  return (
    <article className="page-wrap blog-post">
      <button className="blog-back" onClick={() => navigate("/blog")}><ArrowLeft size={16} /> All articles</button>
      <header className="blog-post-head reveal in">
        {p.tags?.[0] && <span className="page-eyebrow">{p.tags[0]}</span>}
        <h1>{p.title}</h1>
        <div className="blog-post-meta">
          <span>{p.author || "Sawa Tours"}{p.authorCredentials ? ` · ${p.authorCredentials}` : ""}</span>
          {p.publishedAt && <span>{blogDate(p.publishedAt)}</span>}
          {p.geoRegion && <span><MapPin size={14} /> {p.geoRegion}</span>}
        </div>
      </header>
      {p.coverImage && (
        <figure className="blog-post-cover-fig reveal in">
          {/* Alt describes the PICTURE (040); the title only says what the
              article is about, so it is the fallback, not the default. */}
          <img className="blog-post-cover" src={p.coverImage} alt={p.coverAlt || p.title} title={p.coverAlt || undefined} />
          {p.coverCaption && <figcaption>{p.coverCaption}</figcaption>}
        </figure>
      )}
      {p.tldr && <div className="blog-tldr reveal in"><strong>In short</strong><p>{p.tldr}</p></div>}
      <div className="blog-post-body rich reveal in" dangerouslySetInnerHTML={{ __html: p.bodyHtml || "" }} />
      {takeaways.length > 0 && (
        <div className="blog-takeaways reveal in">
          <h2>Key takeaways</h2>
          <ul>{takeaways.map((t, i) => <li key={i}><Check size={16} /> <span>{t}</span></li>)}</ul>
        </div>
      )}
      {faq.length > 0 && (
        <section className="blog-faq reveal in">
          <h2>Frequently asked</h2>
          {faq.map((item, i) => (
            <details className="faq-item" key={i}>
              <summary><span>{item.q}</span><ChevronDown size={18} /></summary>
              <p>{item.a}</p>
            </details>
          ))}
        </section>
      )}
      <PageCTA navigate={navigate} />
    </article>
  );
}

export {
  PublicRoute, PartnersPage, ToursPage, HowItWorksPage, AboutPage, ContactPage, FAQ_GROUPS, FaqPage,
  LegalPage, PRIVACY_SECTIONS, TERMS_SECTIONS, BookingPayment, BookingLookupPage, NotFoundPage, setHeadTag,
  applyRouteHead, upsertMeta, setCanonical, abs, applyPostMeta, resetMeta, blogDate, BlogIndexPage,
  BlogPostPage,
};
