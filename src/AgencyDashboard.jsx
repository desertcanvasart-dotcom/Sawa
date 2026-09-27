import React, { useEffect, useMemo, useState } from "react";
import { priceFromTiers } from "../shared/pricing.js";
import { depositPctFor, balanceDueDate } from "../shared/booking-policy.js";
import { isGoAheadDeparture, isBookingOpen } from "../shared/departure-state.js";
import { CURRENCY_SYMBOL } from "../shared/currency.js";
import {
  LayoutDashboard, Ticket, ClipboardList, Users as UsersIcon, ShieldCheck, ArrowUpRight,
  Check, ChevronDown, AlertTriangle, CalendarDays, MapPin, Package, Hotel, ArrowLeft, Search, Clock3,
  Share2, Copy, Settings as SettingsIcon, Wallet,
} from "lucide-react";
import { DashSidebar } from "./DashSidebar";
import { AgencySettings } from "./AgencySettings.jsx";
import { AgencyMoney } from "./AgencyMoney.jsx";
import { usePortalSection } from "./portal-section.js";
import { useBackToClose, useUnsavedGuard } from "./back-to-close.js";
import { apiFetch } from "./supabaseClient";
import { ProductEditor } from "./AdminDashboard";
// Date-only departure values need a local-noon anchor or they render a day
// early west of UTC — see src/dates.js.
import { fmtDate, fmtReceived } from "./dates.js";
import { RequestCalendar } from "./RequestCalendar.jsx";
import { minLeadDaysFor, maxHorizonDaysFor } from "../shared/request-window.js";
import { operatingDaysLabel } from "../shared/operating-days.js";

const money = (n) => (n == null ? "—" : CURRENCY_SYMBOL + Number(n).toLocaleString());
// Cancelled pledges have released their seats — excluded so seats-left and
// live pricing here match what the server (domain.js) will actually charge.
const seatsOf = (d) => (d.pledges || []).reduce((s, p) => (p?.status === "cancelled" ? s : s + Number(p.seats || 0)), 0);
const isPkg = (x) => x?.type === "package";
const STOCK = {
  Cairo: "/images/cairo.jpg",
  Luxor: "/images/luxor.jpg",
  Aswan: "/images/aswan.jpg",
};
const coverOf = (p) => (p.images && p.images[0]?.url) || STOCK[p.city] || STOCK.Cairo;
const goAheadOf = (x) => Math.max(1, Number(x?.minSeats || 4));
function livePrice(item, seats) {
  const start = Number(item.publishedRate) || 80;
  const brk = Math.min(start, Number(item.breakPrice) || Math.round(start * 0.8));
  const ga = goAheadOf(item), max = Math.max(Number(item.maxSeats || ga), ga);
  const eff = Math.min(max, Math.max(ga, Number(seats || 0)));
  const fromTable = priceFromTiers(item?.priceTiers, eff);
  if (fromTable != null) return fromTable;
  const steps = Math.max(1, max - ga);
  return Math.round(start - (start - brk) * Math.min(1, Math.max(0, eff - ga) / steps));
}

export function AgencyDashboard({ user, agency, signOut, refreshProfile, navigate, departures, tourProducts = [], onReload, agencyDeskProps, AgencyDesk, StaffPanel }) {
  const agencyId = agency?.id;
  const isOwner = user.role === "agency_owner";
  const [section, setSection] = usePortalSection(
    ["overview", "book", "listings", "bookings", "money", "widget", ...(isOwner ? ["team"] : []), "settings"], "overview");
  // Clicking "Book seats" while a tour is open inside it used to do nothing:
  // the section was already active, so the open tour stayed on screen. A
  // repeat click remounts the catalog, which closes the tour (and takes its
  // Back entry off history on unmount).
  const [bookKey, setBookKey] = useState(0);
  // Payment status per booking (043), loaded when My bookings opens. The
  // customer pays Sawa through a Tab link; the agency sees where each one
  // stands and can pass the link on.
  const [payments, setPayments] = useState(null);
  useEffect(() => {
    if (section !== "bookings") return;
    apiFetch("/agency/payments").then((r) => (r.ok ? r.json() : null))
      .then((j) => setPayments(j || { available: false, byPledge: {} }))
      .catch(() => setPayments({ available: false, byPledge: {} }));
  }, [section, departures]);
  const selectSection = (id) => {
    if (id === section && id === "book") { setBookKey((k) => k + 1); window.scrollTo({ top: 0 }); return; }
    setSection(id);
  };

  // built after `stats` so badges can read live counts (see below)

  // This agency's pledges across all departures (own detail is un-redacted server-side).
  const myRows = useMemo(() => {
    const rows = [];
    for (const d of departures) {
      for (const p of d.pledges || []) {
        if (p.agencyId === agencyId) rows.push({ ...p, departure: d });
      }
    }
    return rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [departures, agencyId]);

  const stats = useMemo(() => {
    const myDeps = departures.filter((d) => (d.pledges || []).some((p) => p.agencyId === agencyId));
    // Cancelled bookings hold no seats and earn no revenue — keep them out of
    // the headline numbers (the list below still shows them, tagged).
    const live = myRows.filter((r) => r.status !== "cancelled");
    const seats = live.reduce((s, r) => s + Number(r.seats || 0), 0);
    const confirmed = myDeps.filter((d) => d.status === "supplier_confirmed").length;
    const needsMore = myDeps.filter((d) => d.status !== "supplier_confirmed" && d.status !== "cancelled" && seatsOf(d) < (d.minSeats || 4));
    const value = live.reduce((s, r) => s + Number(r.bookingTotal || 0), 0);
    return { bookings: live.length, seats, confirmed, needsMore, value, departures: myDeps.length };
  }, [departures, myRows, agencyId]);

  // Four groups, divided by a thin rule: the overview; selling (book seats,
  // the bookings that come of it, the money they earn); growing the agency
  // (its own tours, the widget); and the account (settings, the team).
  const navGroups = [
    { title: "Home", items: [{ id: "overview", label: "Overview", icon: LayoutDashboard }] },
    {
      title: "Sell",
      items: [
        { id: "book", label: "Book seats", icon: Ticket },
        { id: "bookings", label: "My bookings", icon: ClipboardList },
        { id: "money", label: "Money", icon: Wallet },
      ],
    },
    {
      title: "Grow",
      items: [
        { id: "listings", label: "List a tour", icon: Package },
        { id: "widget", label: "Promote", icon: Share2 },
      ],
    },
    {
      title: "Account",
      items: [
        { id: "settings", label: "Settings", icon: SettingsIcon },
        ...(isOwner ? [{ id: "team", label: "Team", icon: UsersIcon }] : []),
      ],
    },
  ];

  return (
    <div className="dash">
      <DashSidebar
        brandName={agency?.name || "Agency"}
        subtitle="Agency portal"
        groups={navGroups}
        active={section}
        onSelect={selectSection}
        stats={stats}
        roleLabel={isOwner ? "Owner" : "Agent"}
        user={user}
        navigate={navigate}
        signOut={signOut}
      />

      <main className="dash-main">
        {section === "overview" && (
          <>
            <div className="dash-head"><div><h1>Overview</h1><p>Your agency's bookings and dates at a glance.</p></div>
              <button className="btn-primary" onClick={() => setSection("book")}><Ticket size={16} />Book seats</button>
            </div>
            <div className="kpi-grid">
              <Kpi icon={ClipboardList} label="Your bookings" value={stats.bookings} foot={`${stats.seats} seats total`} />
              <Kpi icon={ShieldCheck} label="Confirmed dates" value={stats.confirmed} foot="GoAhead — running" accent />
              <Kpi icon={CalendarDays} label="Dates joined" value={stats.departures} foot="across all tours" />
              <Kpi icon={AlertTriangle} label="Still forming" value={stats.needsMore.length} foot="need more travelers" />
            </div>
            <div className="dash-card">
              <div className="dash-card-head"><h2>Dates still forming</h2><button className="link-btn" onClick={() => setSection("book")}>Add travelers <ArrowUpRight size={14} /></button></div>
              <div className="mini-list">
                {stats.needsMore.slice(0, 6).map((d) => {
                  const seats = seatsOf(d), min = d.minSeats || 4;
                  return (
                    <div className="mini-row" key={d.id}>
                      <div><strong>{d.route}</strong><span>{d.city} · {fmtDate(d.startDate || d.date)}</span></div>
                      <div className="mini-meter"><i style={{ width: `${Math.min(100, (seats / min) * 100)}%` }} /></div>
                      <b>{seats}/{min}</b>
                    </div>
                  );
                })}
                {stats.needsMore.length === 0 && <div className="dash-empty">Nothing waiting — all your dates have hit their minimum.</div>}
              </div>
            </div>
          </>
        )}

        {section === "book" && (
          <BookTours key={bookKey} tourProducts={tourProducts} departures={departures} agencyId={agencyId} agencyName={agency?.name} agencyPax={stats.seats} onReload={onReload} />
        )}

        {section === "bookings" && (
          <>
            <div className="dash-head"><div><h1>My bookings</h1><p>Every seat your agency has booked.</p></div></div>
            <div className="table-wrap">
              <table className="dash-table">
                <thead><tr><th>Customer</th><th>Tour</th><th>When</th><th>Seats</th><th>Total</th><th>Deposit</th><th>Status</th><th>Payment</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {myRows.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.customers || "—"}</strong></td>
                      <td>{r.departure.route}</td>
                      <td>{fmtDate(r.departure.startDate || r.departure.date)}</td>
                      <td>{r.seats}</td>
                      <td>{money(r.bookingTotal)}</td>
                      <td>{money(r.depositDue)}</td>
                      <td>{r.status === "cancelled" || r.departure.status === "cancelled"
                        ? <span className="tag tag-off">Canceled</span>
                        : r.departure.status === "supplier_confirmed"
                          ? <span className="tag tag-on">Confirmed</span>
                          : isGoAheadDeparture(r.departure)
                            ? <span className="tag tag-on">GoAhead</span>
                            : <span className="tag">Forming</span>}</td>
                      <td><PaymentCell summary={payments?.byPledge?.[r.id]} available={payments?.available} /></td>
                      <td><BookingCancelCell row={r} onDone={onReload} /></td>
                    </tr>
                  ))}
                  {myRows.length === 0 && <tr><td colSpan={9}><div className="dash-empty">No bookings yet. Head to "Book seats" to add your first.</div></td></tr>}
                </tbody>
              </table>
            </div>
            <MyDateRequests onChange={onReload} />
          </>
        )}

        {section === "listings" && <MyListingsSection />}

        {section === "widget" && <WidgetSection tourProducts={tourProducts} />}

        {section === "money" && <AgencyMoney />}

        {section === "settings" && (
          <AgencySettings user={user} agency={agency} isOwner={isOwner} onSaved={refreshProfile} />
        )}

        {section === "team" && isOwner && (
          <>
            <div className="dash-head"><div><h1>Team</h1><p>Give your colleagues their own login.</p></div></div>
            <StaffPanel agencyName={agency?.name} currentUserId={user.id} />
          </>
        )}
      </main>
    </div>
  );
}

/* ---------------- List a tour: submit + track approval ---------------- */
function listingStatusTag(status) {
  if (status === "approved") return <span className="tag tag-on"><Check size={12} /> Live</span>;
  if (status === "rejected") return <span className="tag tag-off">Needs changes</span>;
  return <span className="tag"><Clock3 size={12} /> In review</span>;
}
function MyListingsSection() {
  const [products, setProducts] = useState(null);
  const [editor, setEditor] = useState(null); // {type} for new, {existing} for edit
  const guard = useUnsavedGuard(!!editor, () => setEditor(null));
  const [picking, setPicking] = useState(false);
  useBackToClose(picking, () => setPicking(false));
  const [err, setErr] = useState("");

  async function load() {
    setErr("");
    try {
      const r = await apiFetch("/agency/tour-products");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load your listings.");
      setProducts(j.products || []);
    } catch (e) { setErr(e.message); setProducts([]); }
  }
  useEffect(() => { load(); }, []);

  if (editor) {
    return (
      <div {...guard.dirtyProps}>
        <ProductEditor
          type={editor.existing?.type || editor.type}
          existing={editor.existing}
          agencyMode
          saveEndpoint="/agency/tour-products"
          onClose={guard.requestClose}
          onSaved={() => { setEditor(null); load(); }}
        />
      </div>
    );
  }

  const list = products || [];
  const rejected = list.filter((p) => p.status === "rejected");
  return (
    <>
      <div className="dash-head">
        <div><h1>List a tour</h1><p>Submit a tour for review. Our team approves it before it goes live — you'll get an email either way.</p></div>
        <button className="btn-primary" onClick={() => setPicking(true)}><Package size={16} />List a new tour</button>
      </div>

      {err && <div className="auth-error" role="alert">{err}</div>}

      {rejected.length > 0 && (
        <div className="notice-band warn">
          {rejected.length === 1 ? "1 listing needs changes" : `${rejected.length} listings need changes`} before they can go live — see the reason on each card below, edit, and resubmit.
        </div>
      )}

      {products === null ? (
        <div className="dash-empty">Loading your listings…</div>
      ) : !list.length ? (
        <div className="empty-cta">
          <Package size={26} />
          <h3>No listings yet</h3>
          <p>Create your first tour or package. It won't go live until an admin approves it.</p>
          <button className="btn-primary" onClick={() => setPicking(true)}>List a tour</button>
        </div>
      ) : (
        <div className="listing-grid">
          {list.map((p) => {
            const img = p.images?.[0]?.url;
            return (
              <article className="listing-card" key={p.id}>
                <div className="listing-media">
                  {img ? <img src={img} alt={p.title} /> : <div className="listing-noimg"><Package size={22} /></div>}
                  <span className="listing-type">{p.type === "package" ? "Package" : "Day tour"}</span>
                </div>
                <div className="listing-body">
                  <div className="listing-top"><h3>{p.title || "Untitled"}</h3>{listingStatusTag(p.status)}</div>
                  <p className="listing-agency">{p.city || "—"} · {p.duration || "—"} · {money(p.publishedRate)}/person</p>
                  <p className="listing-desc">{p.description || "No description yet."}</p>
                  {p.status === "rejected" && p.rejectionReason ? (
                    <div className="listing-reject"><strong>Why it was rejected</strong><br />{p.rejectionReason}</div>
                  ) : null}
                  {p.status === "pending" ? <p className="field-hint">Submitted{p.submittedAt ? ` ${fmtDate(p.submittedAt)}` : ""} — waiting for review.</p> : null}
                  {p.status === "approved" ? <p className="field-hint">Live on Sawa. Editing it will send it back for review.</p> : null}
                  <div className="listing-actions">
                    <button className="btn-ghost sm" onClick={() => setEditor({ existing: p })}>
                      {p.status === "rejected" ? "Edit & resubmit" : "Edit"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {picking && (
        <div className="modal-overlay" onClick={() => setPicking(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>What are you listing?</h2></div>
            <div className="modal-body">
              <div className="pick-grid">
                <button className="pick-card" onClick={() => { setPicking(false); setEditor({ type: "day_tour" }); }}>
                  <CalendarDays size={22} /><strong>Day tour</strong><span>A single-day experience.</span>
                </button>
                <button className="pick-card" onClick={() => { setPicking(false); setEditor({ type: "package" }); }}>
                  <Package size={22} /><strong>Multi-day package</strong><span>Several days with nights & itinerary.</span>
                </button>
              </div>
            </div>
            <div className="modal-foot"><button className="btn-ghost" onClick={() => setPicking(false)}>Cancel</button></div>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- Book seats: catalog -> tour detail -> book ---------------- */
function BookTours({ tourProducts, departures, agencyId, agencyName, agencyPax = 0, onReload }) {
  const [openId, setOpenId] = useState(null);
  useBackToClose(!!openId, () => setOpenId(null));
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");

  // Attach each product's live (non-cancelled) departures.
  const catalog = useMemo(() => {
    return (tourProducts || [])
      .filter((p) => p.active !== false)
      .map((p) => ({
        ...p,
        dates: departures
          .filter((d) => d.tourProductId === p.id && d.status !== "cancelled")
          .sort((a, b) => `${a.startDate || a.date}`.localeCompare(`${b.startDate || b.date}`)),
      }));
  }, [tourProducts, departures]);

  const shown = catalog.filter((p) => {
    if (type === "day" && isPkg(p)) return false;
    if (type === "pkg" && !isPkg(p)) return false;
    if (q && !`${p.title} ${p.city} ${(p.cities || []).join(" ")}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const open = openId ? catalog.find((p) => p.id === openId) : null;
  if (open) return <TourBooking product={open} agencyId={agencyId} agencyName={agencyName} agencyPax={agencyPax} onBack={() => setOpenId(null)} onReload={onReload} />;

  return (
    <>
      {/* The title and its description keep the head to themselves; the filter
          and search move to their own row below. Sharing one line meant a long
          description squeezed the controls until "Day tours" wrapped onto two
          lines inside its pill, and the two controls sat at different heights. */}
      <div className="dash-head">
        <div><h1>Book seats</h1><p>Browse tours and packages, open one to see full details, then add your travelers.</p></div>
      </div>

      <div className="catalog-toolbar">
        <div className="seg" role="tablist" aria-label="Filter by tour type">
          {["all", "day", "pkg"].map((k) => (
            <button key={k} role="tab" aria-selected={type === k} className={type === k ? "active" : ""} onClick={() => setType(k)}>
              {k === "all" ? "All" : k === "day" ? "Day tours" : "Packages"}
            </button>
          ))}
        </div>
        <div className="catalog-toolbar-right">
          {/* Filtering gave no feedback at all before — with 13 tours and a
              4-column grid you cannot tell at a glance what a filter did. */}
          <span className="catalog-count" aria-live="polite">
            {shown.length === catalog.length
              ? `${catalog.length} tour${catalog.length === 1 ? "" : "s"}`
              : `${shown.length} of ${catalog.length}`}
          </span>
          <label className="search-box">
            <Search size={16} aria-hidden="true" />
            <input placeholder="Search tours…" aria-label="Search tours" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQ("")}>×</button>
            )}
          </label>
        </div>
      </div>

      <div className="catalog-grid">
        {shown.map((p) => {
          const open = p.dates.filter((d) => seatsOf(d) < d.maxSeats);
          const full = p.dates.length > 0 && open.length === 0;
          const from = p.breakPrice || p.publishedRate;
          return (
            <button key={p.id} className="cat-card" onClick={() => setOpenId(p.id)}>
              <div className="cat-media" style={{ backgroundImage: `url(${coverOf(p)})` }}>
                {isPkg(p) && <span className="cat-flag pkg"><Package size={11} />Package</span>}
                {full && <span className="cat-flag full">Fully booked</span>}
              </div>
              <div className="cat-body">
                <strong>{p.title}</strong>
                <span className="cat-meta"><MapPin size={13} />{isPkg(p) ? (p.cities || [p.city]).join(" → ") : p.city}{p.duration ? ` · ${p.duration}` : ""}</span>
                <div className="cat-foot">
                  <span className="cat-price">from {CURRENCY_SYMBOL}{from}{isPkg(p) ? "/pp" : ""}</span>
                  <span className="cat-dates">{p.dates.length ? `${p.dates.length} date${p.dates.length > 1 ? "s" : ""}` : "Request a date"}</span>
                </div>
              </div>
            </button>
          );
        })}
        {shown.length === 0 && <div className="dash-empty">No tours match. Try a different filter.</div>}
      </div>
    </>
  );
}

function TourBooking({ product, agencyId, agencyName, agencyPax = 0, onBack, onReload }) {
  const pkg = isPkg(product);
  const tiers = product.accommodationTiers || [];
  const bookable = product.dates.filter((d) => seatsOf(d) < d.maxSeats && isBookingOpen(d));
  const [depId, setDepId] = useState(bookable[0]?.id || product.dates[0]?.id || "");
  const [seats, setSeats] = useState(1);
  const [tierId, setTierId] = useState(tiers[0]?.id || "");
  const [rooming, setRooming] = useState("double");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [gi, setGi] = useState(0);
  // "join" an existing date, or "request" a new one for Sawa to approve.
  const [mode, setMode] = useState(product.dates.length ? "join" : "request");

  const dep = product.dates.find((d) => Number(d.id) === Number(depId));
  const booked = dep ? seatsOf(dep) : 0;
  const remaining = dep ? Math.max(0, dep.maxSeats - booked) : 0;
  const goAhead = goAheadOf(dep || product);
  const seatPct = dep && dep.maxSeats ? Math.min(100, Math.round((booked / dep.maxSeats) * 100)) : 0;
  const tier = tiers.find((t) => t.id === tierId) || tiers[0];
  const nSeats = Math.max(1, Number(seats || 1));
  const projected = dep ? Math.min(dep.maxSeats, booked + nSeats) : nSeats;
  // No date chosen (requesting a new one): quote what the tour costs at its
  // GoAhead headcount, from the same table — not the bare publishedRate, which
  // can differ from the tiers the booking is actually priced on.
  let pp = dep ? livePrice({ ...product, ...dep }, projected) : livePrice(product, goAheadOf(product));
  if (pkg && tier) pp += (Number(tier.perPersonSupplement) || 0) + (rooming === "single" ? Number(tier.singleSupplement) || 0 : 0);
  const total = pp * nSeats;
  // The policy's own numbers (shared/booking-policy.js), not a local copy: this
  // said 20% for packages after the rate moved to 25%, and "the day before" for
  // a balance the policy puts at 48 hours (day tour) or 14 days (package).
  const depositPct = Number(dep?.depositPercent || product.depositPercent || depositPctFor(product));
  const deposit = Math.ceil(total * depositPct / 100);
  const balance = Math.max(0, total - deposit);
  const depDate = dep ? (dep.startDate || dep.date) : null;
  const balanceDue = depDate ? fmtDate(balanceDueDate(depDate, product)) : "before departure";

  // Auto reference: agency initial + seats in this booking + running pax total.
  const initial = (agencyName || "X").trim().charAt(0).toUpperCase() || "X";
  const reference = `${initial}-${nSeats}-${(Number(agencyPax) || 0) + nSeats}`;

  const imgs = (product.images || []).filter((i) => i?.url);
  const heroImg = imgs.length ? imgs[Math.min(gi, imgs.length - 1)].url : coverOf(product);

  async function book(e) {
    e.preventDefault();
    setErr(""); setMsg("");
    if (!dep) return setErr("Pick a date.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr("Enter a valid customer email.");
    if (phone.trim().length < 6) return setErr("Enter a customer phone number.");
    if (Number(seats) > remaining) return setErr(`Only ${remaining} seat${remaining === 1 ? "" : "s"} left on this date.`);
    setBusy(true);
    try {
      const body = { seats: nSeats, customers: reference, customerEmail: email.trim(), customerPhone: phone.trim() };
      if (pkg) { body.roomingType = rooming; body.accommodationTier = tierId; }
      const r = await apiFetch(`/departures/${dep.id}/pledges`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not book.");
      setMsg(`Booked ${nSeats} seat${nSeats > 1 ? "s" : ""} — ref ${reference}.`);
      setEmail(""); setPhone(""); setSeats(1);
      onReload && onReload();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <>
      <button className="btn-ghost" onClick={onBack} style={{ marginBottom: 16 }}><ArrowLeft size={16} />All tours</button>
      <div className="tb-grid">
        <div className="tb-main">
          <div className="tb-hero" style={{ backgroundImage: `url(${heroImg})` }} />
          {imgs.length > 1 && (
            <div className="tb-thumbs">
              {imgs.map((im, i) => <button key={i} className={i === gi ? "active" : ""} style={{ backgroundImage: `url(${im.url})` }} onClick={() => setGi(i)} />)}
            </div>
          )}
          <h1 className="tb-title">{product.title} {pkg && <span className="tag tag-pkg">Package</span>}</h1>
          <p className="tb-meta"><MapPin size={14} />{pkg ? (product.cities || [product.city]).join(" → ") : product.city}{product.duration ? ` · ${product.duration}` : ""}{product.guide ? ` · ${product.guide}` : ""}</p>

          {/* The dates the catalog card counts ("2 dates") used to exist only
              as options in the booking panel's dropdown, so an agent opening
              the tour saw no dates anywhere on the page. List them here, with
              how full each one is, and let a click pick one for the form. */}
          <div className="tb-dates">
            <h3><CalendarDays size={15} />{product.dates.length ? `Scheduled dates (${product.dates.length})` : "Scheduled dates"}</h3>
            {product.dates.length ? (
              <ul>
                {product.dates.map((d) => {
                  const n = seatsOf(d);
                  const left = Math.max(0, d.maxSeats - n);
                  const closed = !isBookingOpen(d);
                  const go = isGoAheadDeparture(d);
                  const need = Math.max(0, goAheadOf(d) - n);
                  const chosen = mode === "join" && Number(d.id) === Number(depId);
                  const can = left > 0 && !closed;
                  return (
                    <li key={d.id}>
                      <button type="button" className={chosen ? "tb-date active" : "tb-date"} disabled={!can}
                        aria-pressed={chosen}
                        onClick={() => { setDepId(d.id); setMode("join"); setErr(""); setMsg(""); document.getElementById("tb-book")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }}>
                        <span className="tb-date-when">
                          <strong>{fmtDate(d.startDate || d.date)}</strong>
                          {!pkg && d.time ? <em>{d.time}</em> : null}
                        </span>
                        <span className="tb-date-fill">
                          <span>{n}/{d.maxSeats} booked</span>
                          <i><b style={{ width: `${d.maxSeats ? Math.min(100, Math.round((n / d.maxSeats) * 100)) : 0}%` }} /></i>
                        </span>
                        <span className={go ? "tb-date-tag go" : "tb-date-tag"}>
                          {closed ? "Booking closed" : left <= 0 ? "Full" : go ? "GoAhead ✓" : `${need} to GoAhead`}
                        </span>
                        <span className="tb-date-act">{!can ? "—" : chosen ? "Selected" : "Book this date"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted-line">No dates scheduled yet. Request one in the booking panel and it opens for other travelers to join.</p>
            )}
          </div>

          {hasHtml(product.overviewHtml)
            ? <div className="rich" dangerouslySetInnerHTML={{ __html: product.overviewHtml }} />
            : product.description ? <p className="tb-desc">{product.description}</p> : null}

          <div className="tb-incl">
            <div>
              <h3>What's included</h3>
              {(product.included || []).length ? product.included.map((x) => <p key={x}><Check size={15} />{x}</p>) : <p className="muted-line">Not specified.</p>}
            </div>
            <div>
              <h3>Not included</h3>
              {(product.notIncluded || []).length ? product.notIncluded.map((x) => <p key={x}><ChevronDown size={15} />{x}</p>) : <p className="muted-line">—</p>}
            </div>
          </div>

          {pkg && (product.itinerary || []).length > 0 && (
            <div className="tb-itin">
              <h3>Day-by-day itinerary</h3>
              <ol>
                {product.itinerary.map((d, i) => (
                  <li key={d.day || i}>
                    <div className="tb-day">Day {d.day || i + 1} · {d.city}</div>
                    <strong>{d.title}</strong>
                    {hasHtml(d.description) ? <div className="rich" dangerouslySetInnerHTML={{ __html: d.description }} /> : d.description ? <p>{d.description}</p> : null}
                    <small>Meals: {d.meals || "—"}</small>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {((product.meetingPoints || []).filter((m) => m && m.point).length || product.meetingPoint || (product.whatToBring || []).length || hasHtml(product.policiesHtml)) && (
            <div className="tb-extras">
              {((product.meetingPoints || []).filter((m) => m && m.point).length || product.meetingPoint) && (
                <div>
                  <h3><MapPin size={15} />Meeting &amp; pickup</h3>
                  {(product.meetingPoints || []).filter((m) => m && m.point).length > 0 ? (
                    <ul className="meet-points">
                      {(product.meetingPoints || []).filter((m) => m && m.point).map((m, i) => (
                        <li key={i}><strong>{m.point}</strong>{m.note && <span>{m.note}</span>}</li>
                      ))}
                    </ul>
                  ) : (
                    <><p>{product.meetingPoint}</p>{product.pickupNote && <p className="muted-line">{product.pickupNote}</p>}</>
                  )}
                </div>
              )}
              {(product.whatToBring || []).length > 0 && <div><h3><Check size={15} />What to bring</h3><div className="chip-row">{product.whatToBring.map((b) => <span key={b}>{b}</span>)}</div></div>}
              {hasHtml(product.policiesHtml) && <div><h3><ShieldCheck size={15} />Cancellation & policies</h3><div className="rich" dangerouslySetInnerHTML={{ __html: product.policiesHtml }} /></div>}
            </div>
          )}
        </div>

        <aside className="tb-book" id="tb-book">
          <div className="tb-price">
            <span className="tb-price-cap">Live shared price</span>
            <div className="tb-price-now"><strong>{CURRENCY_SYMBOL}{pp}</strong><em>per person</em></div>
          </div>
          {mode === "request" ? (
            <RequestDateForm
              product={product}
              reference={reference}
              agencyName={agencyName}
              canJoin={product.dates.length > 0}
              onJoin={(id) => { if (id) setDepId(id); setMode("join"); }}
              onDone={onReload}
            />
          ) : (
            <form className="tb-form" onSubmit={book}>
              {dep && (
                <div className="tb-seatbar">
                  <div className="tb-seatbar-top"><span>{booked}/{dep.maxSeats} booked</span><b>GoAhead at {goAhead}</b></div>
                  <div className="tb-seatbar-track"><i style={{ width: `${seatPct}%` }} /></div>
                </div>
              )}

              <div className="tb-field">
                <label htmlFor="bk-date">{pkg ? "Start date" : "Date"}</label>
                <select id="bk-date" value={depId} onChange={(e) => setDepId(e.target.value)}>
                  {product.dates.map((d) => {
                    const left = d.maxSeats - seatsOf(d);
                    return <option key={d.id} value={d.id} disabled={left <= 0}>
                      {pkg ? fmtDate(d.startDate || d.date) : `${fmtDate(d.date)}${d.time ? ` · ${d.time}` : ""}`} — {left > 0 ? `${left} left` : "full"}
                    </option>;
                  })}
                </select>
              </div>

              {pkg ? (
                <>
                  <div className="tb-field">
                    <label htmlFor="bk-tier">Hotel &amp; cruise tier</label>
                    <select id="bk-tier" value={tierId} onChange={(e) => setTierId(e.target.value)}>
                      {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}{t.perPersonSupplement ? ` (+/pp)` : ""}</option>)}
                    </select>
                  </div>
                  <div className="tb-row">
                    <div className="tb-field">
                      <label htmlFor="bk-room">Room type</label>
                      <select id="bk-room" value={rooming} onChange={(e) => setRooming(e.target.value)}>
                        <option value="single">Single</option><option value="double">Double / twin</option><option value="triple">Triple</option>
                      </select>
                    </div>
                    <div className="tb-field tb-seats">
                      <label htmlFor="bk-seats">Seats</label>
                      <input id="bk-seats" type="number" min="1" max={Math.max(1, remaining)} value={seats} onChange={(e) => setSeats(e.target.value)} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="tb-field tb-seats">
                  <label htmlFor="bk-seats">Seats</label>
                  <input id="bk-seats" type="number" min="1" max={Math.max(1, remaining)} value={seats} onChange={(e) => setSeats(e.target.value)} />
                </div>
              )}

              <div className="tb-divider"><span>Customer details</span></div>

              <div className="tb-field">
                <label>Booking reference</label>
                <input className="tb-ref" value={reference} readOnly tabIndex={-1} aria-label="Auto-generated booking reference" />
                <span className="tb-hint">Auto-generated · {agencyName ? `${initial} (${agencyName})` : "agency"} · {nSeats} seat{nSeats > 1 ? "s" : ""}</span>
              </div>
              <div className="tb-row">
                <div className="tb-field">
                  <label htmlFor="bk-email">Customer email</label>
                  <input id="bk-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@email.com" />
                </div>
                <div className="tb-field">
                  <label htmlFor="bk-phone">Customer phone</label>
                  <input id="bk-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" />
                </div>
              </div>

              <div className="tb-summary">
                <div className="tb-sum-row"><span>{CURRENCY_SYMBOL}{pp} × {nSeats} traveler{nSeats > 1 ? "s" : ""}</span><b>{CURRENCY_SYMBOL}{total}</b></div>
                <div className="tb-sum-row tb-sum-key"><span>Deposit at GoAhead ({depositPct}%)</span><b>{CURRENCY_SYMBOL}{deposit}</b></div>
                <div className="tb-sum-row"><span>Balance</span><b>{CURRENCY_SYMBOL}{balance}</b></div>
                <p className="tb-sum-note">Deposit falls due once the date reaches GoAhead. Balance due {balanceDue}.</p>
              </div>

              {err && <div className="auth-error">{err}</div>}
              {msg && <div className="tb-ok"><Check size={15} />{msg}</div>}
              <button className="btn-primary tb-submit" type="submit" disabled={busy || remaining <= 0}><Check size={17} />{busy ? "Booking…" : remaining <= 0 ? "Date full" : "Confirm booking"}</button>
              <button type="button" className="link-btn tb-alt" onClick={() => setMode("request")}>
                <CalendarDays size={14} /> None of these dates work? Request a new date
              </button>
            </form>
          )}
        </aside>
      </div>
    </>
  );
}
function hasHtml(s) { return s && s.replace(/<[^>]*>/g, "").trim().length > 0; }

/* ---------------- Request a new date (operator) ----------------
   The same rules the traveller's request follows — notice period, how far
   ahead, operating days, operator blackouts, and join-first when a date is
   already forming nearby — enforced by the server; the calendar only greys out
   what the server would refuse. Sawa reviews every request before it opens. */
const isoIn = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function RequestDateForm({ product, reference, agencyName, canJoin, onJoin, onDone }) {
  const pkg = isPkg(product);
  const tiers = product.accommodationTiers || [];
  const minIso = isoIn(minLeadDaysFor(product));
  const maxIso = isoIn(maxHorizonDaysFor(product));
  const opDays = Array.isArray(product.operatingDays) ? product.operatingDays : [];
  const [date, setDate] = useState("");
  const [month, setMonth] = useState(() => { const d = new Date(`${minIso}T12:00:00`); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [blocked, setBlocked] = useState(null);
  const [seats, setSeats] = useState(1);
  const [tierId, setTierId] = useState(tiers[0]?.id || "");
  const [rooming, setRooming] = useState("double");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [matches, setMatches] = useState(null);
  const [sent, setSent] = useState(null);

  useEffect(() => {
    apiFetch("/public/unavailable-dates").then((r) => r.json())
      .then((j) => setBlocked(new Set(j.dates || []))).catch(() => setBlocked(new Set()));
  }, []);

  async function submit(e, { ignoreMatches = false } = {}) {
    e?.preventDefault?.();
    setErr("");
    if (!date) return setErr("Pick a date on the calendar.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr("Enter a valid customer email.");
    if (phone.trim().length < 6) return setErr("Enter a customer phone number.");
    setBusy(true);
    try {
      const body = {
        tourProductId: product.id, date, seats: Math.max(1, Number(seats) || 1),
        customers: reference, customerEmail: email.trim(), customerPhone: phone.trim(),
        note: note.trim() || undefined, ignoreMatches,
      };
      if (pkg) { body.roomingType = rooming; body.accommodationTier = tierId; }
      const r = await apiFetch("/agency/departure-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (r.status === 409 && j.code === "near_matches") { setMatches(j.nearMatches || []); return; }
      if (!r.ok) throw new Error(j.error || "Could not send the request.");
      setSent({ date, seats: body.seats });
      setMatches(null);
      onDone && onDone();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  if (sent) {
    return (
      <div className="tb-form">
        <div className="tb-ok"><Check size={15} />Request sent — {fmtDate(sent.date)}, {sent.seats} seat{sent.seats > 1 ? "s" : ""}.</div>
        <p className="tb-sum-note">Sawa reviews every requested date. It opens for booking once approved — follow it under <strong>My bookings → Date requests</strong>. Nothing is charged until the date reaches GoAhead.</p>
        <button type="button" className="btn-ghost" onClick={() => { setSent(null); setDate(""); setEmail(""); setPhone(""); setNote(""); setSeats(1); }}>Request another date</button>
      </div>
    );
  }

  return (
    <form className="tb-form" onSubmit={submit}>
      <div className="tb-field">
        <label>Request a new date</label>
        <span className="tb-hint">
          {minLeadDaysFor(product)} days' notice minimum · up to {maxHorizonDaysFor(product)} days ahead
          {opDays.length ? ` · runs ${operatingDaysLabel(opDays)}` : ""}. Sawa approves every request before it opens.
        </span>
        <RequestCalendar
          value={date}
          operatingDays={opDays}
          blockedDates={blocked}
          minIso={minIso}
          maxIso={maxIso}
          monthCursor={month}
          onCursorChange={(delta) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
          onPick={(d) => { setDate(d); setMatches(null); setErr(""); }}
        />
        {date && <span className="tb-hint"><CalendarDays size={13} /> {fmtDate(date)}</span>}
      </div>

      {matches && (
        <div className="tb-matches" role="alert">
          <strong>Dates are already forming near {fmtDate(date)}.</strong>
          <p>Joining one fills it faster than starting another:</p>
          <ul>
            {matches.map((m) => (
              <li key={m.id}>
                <span>{fmtDate(m.startDate || m.date)} · {seatsOf(m)}/{m.minSeats || 4} to GoAhead</span>
                <button type="button" className="btn-ghost sm" onClick={() => onJoin(m.id)}>Join this date</button>
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn" disabled={busy} onClick={(e) => submit(e, { ignoreMatches: true })}>No — request {fmtDate(date)} anyway</button>
        </div>
      )}

      {pkg && tiers.length > 0 && (
        <div className="tb-row">
          <div className="tb-field">
            <label htmlFor="rq-tier">Hotel &amp; cruise tier</label>
            <select id="rq-tier" value={tierId} onChange={(e) => setTierId(e.target.value)}>
              {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="tb-field">
            <label htmlFor="rq-room">Room type</label>
            <select id="rq-room" value={rooming} onChange={(e) => setRooming(e.target.value)}>
              <option value="single">Single</option><option value="double">Double / twin</option><option value="triple">Triple</option>
            </select>
          </div>
        </div>
      )}
      <div className="tb-field tb-seats">
        <label htmlFor="rq-seats">Seats</label>
        <input id="rq-seats" type="number" min="1" max={product.maxSeats || 12} value={seats} onChange={(e) => setSeats(e.target.value)} />
      </div>

      <div className="tb-divider"><span>Customer details</span></div>
      <div className="tb-field">
        <label>Booking reference</label>
        <input className="tb-ref" value={reference} readOnly tabIndex={-1} aria-label="Auto-generated booking reference" />
        <span className="tb-hint">Auto-generated · {agencyName || "agency"}</span>
      </div>
      <div className="tb-row">
        <div className="tb-field">
          <label htmlFor="rq-email">Customer email</label>
          <input id="rq-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@email.com" />
        </div>
        <div className="tb-field">
          <label htmlFor="rq-phone">Customer phone</label>
          <input id="rq-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" />
        </div>
      </div>
      <div className="tb-field">
        <label htmlFor="rq-note">Note for Sawa (optional)</label>
        <textarea id="rq-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pickup hotel, flexibility on the date…" />
      </div>

      {err && <div className="auth-error">{err}</div>}
      <button className="btn-primary tb-submit" type="submit" disabled={busy}><CalendarDays size={17} />{busy ? "Sending…" : "Send date request"}</button>
      {canJoin && (
        <button type="button" className="link-btn tb-alt" onClick={() => onJoin(null)}>Back to published dates</button>
      )}
    </form>
  );
}

/* ---------------- Cancelling a booking ----------------
   Free and self-serve before GoAhead (Terms §13.1); after it, §13.2's schedule
   applies and the server refuses — so the button is only offered while the
   server would accept it, and a GoAhead booking points to Sawa instead. The
   booking is marked cancelled, not erased: it stays in this list, tagged. */
async function cancelBooking(pledgeId) {
  const r = await apiFetch(`/agency/bookings/${encodeURIComponent(pledgeId)}/cancel`, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Could not cancel this booking. Please retry.");
}

function CancelButton({ pledgeId, label, confirmText, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function run() {
    if (!window.confirm(confirmText)) return;
    setBusy(true); setErr("");
    try { await cancelBooking(pledgeId); await onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className="link-btn link-danger" onClick={run} disabled={busy}>{busy ? "Canceling…" : label}</button>
      {err && <div className="sub cancel-err" role="alert">{err}</div>}
    </>
  );
}

function BookingCancelCell({ row, onDone }) {
  const d = row.departure;
  if (row.status === "cancelled" || d.status === "cancelled") return null;
  if (d.status === "supplier_confirmed" || isGoAheadDeparture(d)) {
    return <a className="sub" href="mailto:hello@sawa.tours">Contact Sawa to cancel</a>;
  }
  return (
    <CancelButton
      pledgeId={row.id}
      label="Cancel"
      confirmText={`Cancel ${row.customers || "this booking"} (${row.seats} seat${Number(row.seats) === 1 ? "" : "s"}) on ${d.route}? The seat is released and nothing is charged.`}
      onDone={onDone}
    />
  );
}

/* ---------------- Payment status (043) ---------------- */
const PAY_TONE = { deposit_link_needed: "tag-warn", balance_link_needed: "tag-warn", overdue: "tag-alert", deposit_paid: "tag-on", paid_in_full: "tag-on", cancelled: "tag-off", not_due: "tag-off" };
function PaymentCell({ summary, available }) {
  const [copied, setCopied] = useState(false);
  if (!available || !summary) return <span className="sub">—</span>;
  // Before GoAhead nothing is owed; after it, a link needed is Sawa's to send,
  // so the agency sees "Awaiting link" rather than an instruction.
  const label = summary.stage === "deposit_link_needed" || summary.stage === "balance_link_needed" ? "Awaiting link" : summary.label;
  const copy = async () => {
    try { await navigator.clipboard.writeText(summary.open.linkUrl); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch (e) { window.prompt("Copy the payment link:", summary.open.linkUrl); }
  };
  return (
    <div className="pay-cell">
      <span className={`tag ${PAY_TONE[summary.stage] || ""}`}>{label}</span>
      {summary.paid > 0 && <div className="sub">{money(summary.paid)} paid</div>}
      {summary.open && (
        <div className="sub">
          {money(summary.open.amount)} due {fmtDate(summary.open.dueAt)}{" "}
          <button type="button" className="link-btn" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- My date requests ---------------- */
function requestStateTag(r) {
  if (r.bookingStatus === "cancelled" && r.departureStatus !== "cancelled") return <span className="tag tag-off">Withdrawn</span>;
  if (r.bookingStatus === "cancelled" || r.departureStatus === "cancelled") return <span className="tag tag-off">Declined / closed</span>;
  if (r.departureStatus === "pending_review") return <span className="tag tag-warn"><Clock3 size={12} /> Under review</span>;
  return <span className="tag tag-on"><Check size={12} /> Approved — open</span>;
}

function MyDateRequests({ onChange }) {
  const [rows, setRows] = useState(null);
  const load = () => apiFetch("/agency/departure-requests").then((r) => r.json())
    .then((j) => setRows(j.requests || [])).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  if (!rows || rows.length === 0) return null;
  return (
    <>
      <div className="dash-head" style={{ marginTop: 28 }}><div><h2>Date requests</h2><p>New dates you asked Sawa to open.</p></div></div>
      <div className="table-wrap">
        <table className="dash-table">
          <thead><tr><th>Reference</th><th>Tour</th><th>Date</th><th>Seats</th><th>Requested</th><th>Status</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.customers || "—"}</strong>{r.customerEmail && <div className="sub">{r.customerEmail}</div>}</td>
                <td>{r.route}</td>
                <td>{fmtDate(r.date)}</td>
                <td>{r.seats}</td>
                <td className="sub">{fmtReceived(r.createdAt)}</td>
                <td>{requestStateTag(r)}</td>
                <td>{r.departureStatus === "pending_review" && r.bookingStatus !== "cancelled" && (
                  <CancelButton
                    pledgeId={r.id}
                    label="Withdraw"
                    confirmText={`Withdraw the request for ${r.route} on ${fmtDate(r.date)}?`}
                    onDone={async () => { await load(); await onChange?.(); }}
                  />
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------- Promote: self-serve tracked widget ---------------- */
const EMBED_SCRIPT = `<script>
(function(){function s(f){try{var c=getComputedStyle(document.body),a=document.querySelector('a');f.contentWindow.postMessage({type:'sawa-embed-theme',bg:c.backgroundColor,text:c.color,accent:a?getComputedStyle(a).color:''},'*');}catch(e){}}
addEventListener('message',function(e){if(!e.data)return;document.querySelectorAll('iframe[data-sawa-embed]').forEach(function(f){if(f.contentWindow!==e.source)return;if(e.data.type==='sawa-embed-height')f.style.height=e.data.height+'px';if(e.data.type==='sawa-embed-ready')s(f);if(e.data.type==='sawa-embed-top'&&f.getBoundingClientRect().top<0)f.scrollIntoView({behavior:'smooth',block:'start'});});});
addEventListener('load',function(){document.querySelectorAll('iframe[data-sawa-embed]').forEach(s);});})();
<\/script>`;

function WidgetSection({ tourProducts = [] }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState("");
  const [productId, setProductId] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    apiFetch("/agency/widget").then((r) => r.json()).then((j) => {
      if (j.error) throw new Error(j.error);
      setInfo(j);
    }).catch(() => setErr("Could not load your widget. Please retry."));
  }, []);

  const SITE = "https://sawa.tours";
  const code = info?.code;
  const products = (tourProducts || []).filter((p) => p.active !== false);
  const prod = products.find((p) => p.id === productId);
  const iframe = (src) => `<iframe src="${SITE}${src}" style="width:100%;border:0;border-radius:18px" loading="lazy" data-sawa-embed></iframe>`;
  const brandSnippet = code ? `${iframe(`/embed?ref=${code}`)}\n${EMBED_SCRIPT}` : "";
  const prodSnippet = (code && prod) ? `${iframe(`/embed/${isPkg(prod) ? "package" : "tour"}/${prod.id}?ref=${code}`)}\n${EMBED_SCRIPT}` : "";
  // Booking inside the widget: the visitor books without leaving the agency's
  // site, and the booking carries this agency's code straight from the iframe.
  const bookAllSnippet = code ? `${iframe(`/embed/book?ref=${code}`)}\n${EMBED_SCRIPT}` : "";
  const bookProdSnippet = (code && prod) ? `${iframe(`/embed/book/${isPkg(prod) ? "package" : "tour"}/${prod.id}?ref=${code}`)}\n${EMBED_SCRIPT}` : "";

  const copy = async (text, key) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1800); }
    catch (e) { setCopied(""); }
  };

  return (
    <>
      <div className="dash-head"><div><h1>Promote Sawa</h1><p>Put the Sawa widget on your own website, blog or social bio. Every booking it brings is tracked to your agency.</p></div></div>
      {err && <div className="auth-error">{err}</div>}
      {info && (
        <>
          <div className="kpi-grid">
            <Kpi icon={Share2} label="Your code" value={info.code} foot="added to your widget automatically" />
            <Kpi icon={ArrowUpRight} label="Click-throughs" value={info.visits} foot="visits from your widget" />
            <Kpi icon={ClipboardList} label="Bookings" value={info.bookings} foot="credited to you" accent />
            <Kpi icon={CalendarDays} label="Revenue" value={money(info.revenue)} foot="from your referrals" />
          </div>

          <WidgetPreview code={code} products={products} productId={productId} setProductId={setProductId} />

          <div className="dash-card">
            <div className="dash-card-head">
              <h2>Booking widget — all tours</h2>
              <button className="btn-ghost sm" onClick={() => copy(bookAllSnippet, "bookAll")}><Copy size={14} />{copied === "bookAll" ? "Copied!" : "Copy code"}</button>
            </div>
            <p className="field-hint">Your customers browse every Sawa tour and book it <b>on your website</b> — they never leave your page. Each booking is credited to {info.name || "your agency"}, and the widget shows “Booked through {info.name || "your agency"}”.</p>
            <textarea className="embed-snippet" readOnly rows={5} value={bookAllSnippet} onFocus={(e) => e.target.select()} />
          </div>

          <div className="dash-card">
            <div className="dash-card-head">
              <h2>Website banner <span className="field-hint" style={{ fontWeight: 500 }}>· opens sawa.tours</span></h2>
              <button className="btn-ghost sm" onClick={() => copy(brandSnippet, "brand")}><Copy size={14} />{copied === "brand" ? "Copied!" : "Copy code"}</button>
            </div>
            <p className="field-hint">Paste anywhere — your website, a WordPress “Custom HTML” block, or hand it to your designer or an AI website builder. It matches your site's colors automatically.</p>
            <textarea className="embed-snippet" readOnly rows={5} value={brandSnippet} onFocus={(e) => e.target.select()} />
          </div>

          <div className="dash-card">
            <div className="dash-card-head">
              <h2>Promote a specific tour or package</h2>
            </div>
            <select className="embed-select" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Choose a tour or package…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{isPkg(p) ? "Package" : "Tour"} — {p.title}</option>)}
            </select>
            {prod && (
              <>
                <div className="dash-card-head" style={{ marginTop: 4 }}>
                  <h3 style={{ margin: 0, fontSize: 14 }}>Book on your website</h3>
                  <button className="btn-ghost sm" onClick={() => copy(bookProdSnippet, "bookProd")}><Copy size={14} />{copied === "bookProd" ? "Copied!" : "Copy code"}</button>
                </div>
                <p className="field-hint">Dates, prices and the booking form for this tour, inside your page.</p>
                <textarea className="embed-snippet" readOnly rows={5} value={bookProdSnippet} onFocus={(e) => e.target.select()} />
                <div className="dash-card-head" style={{ marginTop: 14 }}>
                  <h3 style={{ margin: 0, fontSize: 14 }}>Compact card <span className="field-hint" style={{ fontWeight: 500 }}>· opens sawa.tours</span></h3>
                  <button className="btn-ghost sm" onClick={() => copy(prodSnippet, "prod")}><Copy size={14} />{copied === "prod" ? "Copied!" : "Copy code"}</button>
                </div>
                <textarea className="embed-snippet" readOnly rows={5} value={prodSnippet} onFocus={(e) => e.target.select()} />
              </>
            )}
          </div>
        </>
      )}
      {!info && !err && <div className="dash-empty">Loading your widget…</div>}
    </>
  );
}

// The agency's own widget, live, as its customers will see it: the real
// /embed pages in a frame, in preview mode (?preview=1) so trying it books
// nothing, texts no code and counts no click-through.
const PREVIEW_KINDS = [
  { id: "book", label: "Booking widget — all tours" },
  { id: "bookProd", label: "Booking widget — one tour", needsTour: true },
  { id: "banner", label: "Website banner" },
  { id: "card", label: "Compact card", needsTour: true },
];
function WidgetPreview({ code, products, productId, setProductId }) {
  const [kind, setKind] = useState("book");
  const [device, setDevice] = useState("desktop");
  const [height, setHeight] = useState(420);
  const frameRef = React.useRef(null);
  const prod = products.find((p) => p.id === productId);
  const current = PREVIEW_KINDS.find((k) => k.id === kind);
  const type = prod && (isPkg(prod) ? "package" : "tour");
  const q = `?ref=${encodeURIComponent(code)}&preview=1`;
  const src = current.needsTour
    ? (prod ? (kind === "bookProd" ? `/embed/book/${type}/${prod.id}${q}` : `/embed/${type}/${prod.id}${q}`) : "")
    : kind === "book" ? `/embed/book${q}` : `/embed${q}`;

  // The widget reports its height, as it does to the snippet's script on a
  // partner's site; only this frame's messages count.
  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== frameRef.current?.contentWindow || !e.data) return;
      if (e.data.type === "sawa-embed-height") setHeight(Math.max(120, Number(e.data.height) || 0));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <div className="dash-card">
      <div className="dash-card-head">
        <h2>Preview</h2>
        <div className="seg" role="tablist" aria-label="Preview size">
          {[["desktop", "Desktop"], ["phone", "Phone"]].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={device === id} className={device === id ? "active" : ""} onClick={() => setDevice(id)}>{label}</button>
          ))}
        </div>
      </div>
      <p className="field-hint">This is your live widget. Click around and fill in the form — in the preview nothing is booked and nothing is counted.</p>
      <div className="wp-controls">
        <select className="embed-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Widget to preview">
          {PREVIEW_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        {current.needsTour && (
          <select className="embed-select" value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Tour to preview">
            <option value="">Choose a tour or package…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{isPkg(p) ? "Package" : "Tour"} — {p.title}</option>)}
          </select>
        )}
      </div>
      <div className={`wp-stage wp-${device}`}>
        {src
          ? <iframe key={src} ref={frameRef} src={src} title="Widget preview" className="wp-frame" style={{ height }} />
          : <div className="dash-empty">Choose a tour to preview this widget.</div>}
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, foot, accent }) {
  return (
    <div className={`kpi ${accent ? "kpi-accent" : ""}`}>
      <div className="kpi-top"><Icon size={18} strokeWidth={2} /><span>{label}</span></div>
      <strong>{value}</strong>
      {foot && <p>{foot}</p>}
    </div>
  );
}
