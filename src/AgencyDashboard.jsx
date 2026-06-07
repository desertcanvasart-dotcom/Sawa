import React, { useMemo, useState } from "react";
import {
  LayoutDashboard, Ticket, ClipboardList, Users as UsersIcon, ShieldCheck, ArrowUpRight,
  Check, ChevronDown, AlertTriangle, CalendarDays, MapPin, Package, Hotel, ArrowLeft, Search, Clock3,
} from "lucide-react";
import { DashSidebar } from "./DashSidebar";
import { apiFetch } from "./supabaseClient";

const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString());
const fmtDate = (d) => (d ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(d)) : "—");
const seatsOf = (d) => (d.pledges || []).reduce((s, p) => s + Number(p.seats || 0), 0);
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
  const steps = Math.max(1, max - ga);
  return Math.round(start - (start - brk) * Math.min(1, Math.max(0, eff - ga) / steps));
}

export function AgencyDashboard({ user, agency, signOut, navigate, departures, tourProducts = [], onReload, agencyDeskProps, AgencyDesk, StaffPanel }) {
  const [section, setSection] = useState("overview");
  const agencyId = agency?.id;
  const isOwner = user.role === "agency_owner";

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
    const seats = myRows.reduce((s, r) => s + Number(r.seats || 0), 0);
    const confirmed = myDeps.filter((d) => d.status === "supplier_confirmed").length;
    const needsMore = myDeps.filter((d) => d.status !== "supplier_confirmed" && d.status !== "cancelled" && seatsOf(d) < (d.minSeats || 4));
    const value = myRows.reduce((s, r) => s + Number(r.bookingTotal || 0), 0);
    return { bookings: myRows.length, seats, confirmed, needsMore, value, departures: myDeps.length };
  }, [departures, myRows, agencyId]);

  const navGroups = [
    {
      title: null,
      items: [
        { id: "overview", label: "Overview", icon: LayoutDashboard },
        { id: "book", label: "Book seats", icon: Ticket },
        { id: "bookings", label: "My bookings", icon: ClipboardList },
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
        onSelect={setSection}
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
              <Kpi icon={AlertTriangle} label="Still forming" value={stats.needsMore.length} foot="need more travellers" />
            </div>
            <div className="dash-card">
              <div className="dash-card-head"><h2>Dates still forming</h2><button className="link-btn" onClick={() => setSection("book")}>Add travellers <ArrowUpRight size={14} /></button></div>
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
          <BookTours tourProducts={tourProducts} departures={departures} agencyId={agencyId} onReload={onReload} />
        )}

        {section === "bookings" && (
          <>
            <div className="dash-head"><div><h1>My bookings</h1><p>Every seat your agency has booked.</p></div></div>
            <div className="table-wrap">
              <table className="dash-table">
                <thead><tr><th>Customer</th><th>Tour</th><th>When</th><th>Seats</th><th>Total</th><th>Deposit</th><th>Status</th></tr></thead>
                <tbody>
                  {myRows.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.customers || "—"}</strong></td>
                      <td>{r.departure.route}</td>
                      <td>{fmtDate(r.departure.startDate || r.departure.date)}</td>
                      <td>{r.seats}</td>
                      <td>{money(r.bookingTotal)}</td>
                      <td>{money(r.depositDue)}</td>
                      <td>{r.departure.status === "supplier_confirmed"
                        ? <span className="tag tag-on">Confirmed</span>
                        : r.departure.status === "cancelled"
                          ? <span className="tag tag-off">Cancelled</span>
                          : <span className="tag">Forming</span>}</td>
                    </tr>
                  ))}
                  {myRows.length === 0 && <tr><td colSpan={7}><div className="dash-empty">No bookings yet. Head to "Book seats" to add your first.</div></td></tr>}
                </tbody>
              </table>
            </div>
          </>
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

/* ---------------- Book seats: catalog -> tour detail -> book ---------------- */
function BookTours({ tourProducts, departures, agencyId, onReload }) {
  const [openId, setOpenId] = useState(null);
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
  if (open) return <TourBooking product={open} agencyId={agencyId} onBack={() => setOpenId(null)} onReload={onReload} />;

  return (
    <>
      <div className="dash-head">
        <div><h1>Book seats</h1><p>Browse tours and packages, open one to see full details, then add your travellers.</p></div>
        <div className="head-actions">
          <div className="seg">
            {["all", "day", "pkg"].map((k) => (
              <button key={k} className={type === k ? "active" : ""} onClick={() => setType(k)}>{k === "all" ? "All" : k === "day" ? "Day tours" : "Packages"}</button>
            ))}
          </div>
          <div className="search-box"><Search size={16} /><input placeholder="Search tours…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </div>
      </div>

      <div className="catalog-grid">
        {shown.map((p) => {
          const open = p.dates.filter((d) => seatsOf(d) < d.maxSeats);
          const full = p.dates.length > 0 && open.length === 0;
          const from = p.breakPrice || p.publishedRate;
          return (
            <button key={p.id} className="cat-card" onClick={() => setOpenId(p.id)} disabled={!p.dates.length}>
              <div className="cat-media" style={{ backgroundImage: `url(${coverOf(p)})` }}>
                {isPkg(p) && <span className="cat-flag pkg"><Package size={11} />Package</span>}
                {full && <span className="cat-flag full">Fully booked</span>}
              </div>
              <div className="cat-body">
                <strong>{p.title}</strong>
                <span className="cat-meta"><MapPin size={13} />{isPkg(p) ? (p.cities || [p.city]).join(" → ") : p.city}{p.duration ? ` · ${p.duration}` : ""}</span>
                <div className="cat-foot">
                  <span className="cat-price">from ${from}{isPkg(p) ? "/pp" : ""}</span>
                  <span className="cat-dates">{p.dates.length ? `${p.dates.length} date${p.dates.length > 1 ? "s" : ""}` : "No dates yet"}</span>
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

function TourBooking({ product, agencyId, onBack, onReload }) {
  const pkg = isPkg(product);
  const tiers = product.accommodationTiers || [];
  const bookable = product.dates.filter((d) => seatsOf(d) < d.maxSeats);
  const [depId, setDepId] = useState(bookable[0]?.id || product.dates[0]?.id || "");
  const [seats, setSeats] = useState(1);
  const [tierId, setTierId] = useState(tiers[0]?.id || "");
  const [rooming, setRooming] = useState("double");
  const [customers, setCustomers] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [gi, setGi] = useState(0);

  const dep = product.dates.find((d) => Number(d.id) === Number(depId));
  const booked = dep ? seatsOf(dep) : 0;
  const remaining = dep ? Math.max(0, dep.maxSeats - booked) : 0;
  const tier = tiers.find((t) => t.id === tierId) || tiers[0];
  const projected = dep ? Math.min(dep.maxSeats, booked + Number(seats || 1)) : Number(seats || 1);
  let pp = dep ? livePrice({ ...product, ...dep }, projected) : product.publishedRate;
  if (pkg && tier) pp += (Number(tier.perPersonSupplement) || 0) + (rooming === "single" ? Number(tier.singleSupplement) || 0 : 0);
  const total = pp * Number(seats || 1);
  const depositPct = Number(dep?.depositPercent || product.depositPercent || (pkg ? 20 : 10));
  const deposit = Math.ceil(total * depositPct / 100);

  const imgs = (product.images || []).filter((i) => i?.url);
  const heroImg = imgs.length ? imgs[Math.min(gi, imgs.length - 1)].url : coverOf(product);

  async function book(e) {
    e.preventDefault();
    setErr(""); setMsg("");
    if (!dep) return setErr("Pick a date.");
    if (!customers.trim()) return setErr("Add a customer reference (name or party).");
    if (Number(seats) > remaining) return setErr(`Only ${remaining} seat${remaining === 1 ? "" : "s"} left on this date.`);
    setBusy(true);
    try {
      const body = { seats: Number(seats), customers: customers.trim(), customerPhone: phone.trim() };
      if (pkg) { body.roomingType = rooming; body.accommodationTier = tierId; }
      const r = await apiFetch(`/departures/${dep.id}/pledges`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not book.");
      setMsg(`Booked ${seats} seat${seats > 1 ? "s" : ""} for ${customers.trim()}.`);
      setCustomers(""); setPhone(""); setSeats(1);
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

        <aside className="tb-book">
          <div className="tb-book-head">
            <span>From</span>
            <strong>${pp}{pkg ? " /person" : ""}</strong>
          </div>
          {!product.dates.length ? (
            <div className="dash-empty">No dates published yet. Ask the admin to publish a departure.</div>
          ) : (
            <form className="tb-form" onSubmit={book}>
              <label>{pkg ? "Start date" : "Date"}
                <select value={depId} onChange={(e) => setDepId(e.target.value)}>
                  {product.dates.map((d) => {
                    const left = d.maxSeats - seatsOf(d);
                    return <option key={d.id} value={d.id} disabled={left <= 0}>
                      {pkg ? fmtDate(d.startDate || d.date) : `${fmtDate(d.date)}${d.time ? ` · ${d.time}` : ""}`} — {left > 0 ? `${left} left` : "full"}
                    </option>;
                  })}
                </select>
              </label>
              <label>Seats
                <input type="number" min="1" max={Math.max(1, remaining)} value={seats} onChange={(e) => setSeats(e.target.value)} />
              </label>
              {pkg && (
                <>
                  <label>Hotel tier
                    <select value={tierId} onChange={(e) => setTierId(e.target.value)}>
                      {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}{t.perPersonSupplement ? ` (+$${t.perPersonSupplement}/pp)` : ""}</option>)}
                    </select>
                  </label>
                  <label>Room type
                    <select value={rooming} onChange={(e) => setRooming(e.target.value)}>
                      <option value="single">Single</option><option value="double">Double / twin</option><option value="triple">Triple</option>
                    </select>
                  </label>
                </>
              )}
              <label>Customer reference
                <input value={customers} onChange={(e) => setCustomers(e.target.value)} placeholder="Name, party, voucher ID" />
              </label>
              <label>Customer phone <span className="field-opt">(optional)</span>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" />
              </label>

              <div className="tb-summary">
                <div><span>{booked}/{dep?.maxSeats} booked · GoAhead at {goAheadOf(dep || product)}</span></div>
                <div className="tb-money"><span>Total</span><strong>${total}</strong></div>
                <div className="tb-money"><span>Deposit ({depositPct}%)</span><strong>${deposit}</strong></div>
              </div>

              {err && <div className="auth-error">{err}</div>}
              {msg && <div className="temp-pass" style={{ margin: 0 }}><strong>{msg}</strong></div>}
              <button className="btn-primary" type="submit" disabled={busy || remaining <= 0}><Check size={17} />{busy ? "Booking…" : remaining <= 0 ? "Date full" : "Book seats"}</button>
            </form>
          )}
        </aside>
      </div>
    </>
  );
}
function hasHtml(s) { return s && s.replace(/<[^>]*>/g, "").trim().length > 0; }

function Kpi({ icon: Icon, label, value, foot, accent }) {
  return (
    <div className={`kpi ${accent ? "kpi-accent" : ""}`}>
      <div className="kpi-top"><Icon size={18} strokeWidth={2} /><span>{label}</span></div>
      <strong>{value}</strong>
      {foot && <p>{foot}</p>}
    </div>
  );
}
