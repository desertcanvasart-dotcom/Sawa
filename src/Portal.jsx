// The signed-in shell: the portal frame with its three desks, an agency owner's team panel, and the agency's tour preview and desk
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import React, { lazy, useState, useEffect } from "react";
import {
  Users,
  Plus,
  Trash2,
  Package,
  MapPin,
  CalendarDays,
  Car,
  Clock3,
  Check,
  ChevronDown,
  Search,
  Filter,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { cutoffLabel, isPackage } from "../shared/booking-policy.js";
import { seatsTotal, goAheadSeatsFor, isGoAheadDeparture } from "../shared/departure-state.js";
import { CURRENCY_SYMBOL } from "../shared/currency.js";
import { MAX_GROUP_SIZE } from "../shared/group-size.js";
import { apiFetch } from "./supabaseClient";
import { coverImage, formatRange, formatDate, departureStatusLabel, rateFor } from "./tour-helpers.jsx";
import { RichBlock, TourExtras } from "./TourCards.jsx";

// The three desks, each its own chunk: a visitor never downloads the admin desk,
// and a signed-in user downloads only their own.
const AdminDashboard = lazy(() => import("./AdminDashboard").then((m) => ({ default: m.AdminDashboard })));
const AgencyDashboard = lazy(() => import("./AgencyDashboard").then((m) => ({ default: m.AgencyDashboard })));
const OperatorDashboard = lazy(() => import("./OperatorDashboard.jsx").then((m) => ({ default: m.OperatorDashboard })));

// ---- Authenticated portal shell: role decides which desk shows ----
function Portal({ user, agency, signOut, refreshProfile, navigate, notice, cityStats, departures, selectedCity, setSelectedCity, selectedCityStats, agencyDeskProps, adminDeskProps }) {
  const isPlatform = user.role === "super_admin" || user.role === "ops_staff";
  const selected = agencyDeskProps.selected;

  // Platform staff get the full operations dashboard (own nav + sections).
  if (isPlatform) {
    return <AdminDashboard user={user} agency={agency} signOut={signOut} navigate={navigate} />;
  }

  // Model phase 2 — operator logins get their own portal (the server answers
  // 404 to it while catalogue_v2 is off).
  if (user.role === "operator_owner" || user.role === "operator_staff") {
    return <OperatorDashboard user={user} signOut={signOut} navigate={navigate} />;
  }

  // Agency users get the clean agency dashboard, reusing the existing
  // AgencyDesk (booking) and StaffPanel (team) components.
  return (
    <AgencyDashboard
      user={user}
      agency={agency}
      signOut={signOut}
      refreshProfile={refreshProfile}
      navigate={navigate}
      departures={departures}
      tourProducts={agencyDeskProps.tourProducts}
      onReload={agencyDeskProps.onReload}
      agencyDeskProps={agencyDeskProps}
      AgencyDesk={AgencyDesk}
      StaffPanel={StaffPanel}
    />
  );
}

function roleLabel(role) {
  return {
    super_admin: "Super admin",
    ops_staff: "Operations",
    agency_owner: "Agency owner",
    operator_owner: "Operator owner",
    operator_staff: "Operator staff",
    agency_agent: "Agent",
  }[role] || role;
}

// ---- Agency owner: manage their team ----
function StaffPanel({ agencyName, currentUserId }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("agency_agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null); // {email, tempPassword}

  async function load() {
    try {
      const res = await apiFetch("/agency/staff");
      const data = await res.json();
      if (res.ok) setStaff(data.staff || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function addStaff(e) {
    e.preventDefault();
    setBusy(true); setError(""); setCreated(null);
    try {
      const res = await apiFetch("/agency/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), fullName: fullName.trim(), role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add the team member.");
      setCreated({ email: data.staff.email, tempPassword: data.tempPassword });
      setEmail(""); setFullName(""); setRole("agency_agent");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id, status) {
    await apiFetch(`/agency/staff/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  }
  async function changeRole(id, newRole) {
    await apiFetch(`/agency/staff/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    load();
  }
  async function remove(id) {
    await apiFetch(`/agency/staff/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <section className="panel team-panel" id="team">
      <div className="panel-header">
        <div><h2>Your team</h2><p>Give your colleagues their own login for {agencyName || "your agency"}.</p></div>
        <Users size={20} />
      </div>

      <form className="team-add" onSubmit={addStaff}>
        <div className="field">
          <label htmlFor="st-name">Full name</label>
          <input id="st-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Yara Mansour" />
        </div>
        <div className="field">
          <label htmlFor="st-email">Email</label>
          <input id="st-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@agency.com" />
        </div>
        <div className="field">
          <label htmlFor="st-role">Role</label>
          <select id="st-role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="agency_agent">Agent — books seats</option>
            <option value="agency_owner">Owner — also manages the team</option>
          </select>
        </div>
        <button className="primary" type="submit" disabled={busy}>
          <Plus size={17} />{busy ? "Adding…" : "Add team member"}
        </button>
      </form>

      {error && <div className="auth-error" role="alert">{error}</div>}
      {created && (
        <div className="temp-pass" role="status">
          <strong>{created.email} can now sign in.</strong>
          <p>Share this one-time password — it won't be shown again:</p>
          <code>{created.tempPassword}</code>
          <span>They can change it after their first sign-in. (Email invites arrive in a later update.)</span>
        </div>
      )}

      <div className="team-list">
        {loading && <p className="field-hint">Loading team…</p>}
        {!loading && staff.map((m) => (
          <div className={`team-row ${m.status === "disabled" ? "is-disabled" : ""}`} key={m.id}>
            <div className="team-who">
              <strong>{m.fullName || m.email}</strong>
              <span>{m.email}</span>
            </div>
            <span className="team-role">{roleLabel(m.role)}</span>
            <span className={`team-status ${m.status}`}>{m.status === "active" ? "Active" : "Disabled"}</span>
            <div className="team-actions">
              {m.id === currentUserId ? (
                <span className="team-you">You</span>
              ) : (
                <>
                  <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)} aria-label="Change role">
                    <option value="agency_agent">Agent</option>
                    <option value="agency_owner">Owner</option>
                  </select>
                  {m.status === "active"
                    ? <button className="ghost-danger" onClick={() => setStatus(m.id, "disabled")}>Disable</button>
                    : <button className="ghost" onClick={() => setStatus(m.id, "active")}>Re-enable</button>}
                  <button className="danger-icon" onClick={() => remove(m.id)} aria-label="Remove"><Trash2 size={15} /></button>
                </>
              )}
            </div>
          </div>
        ))}
        {!loading && staff.length === 0 && <p className="empty-day">No team members yet.</p>}
      </div>
    </section>
  );
}

// Full tour details shown to the agency while booking, so they know exactly
// what they're selling: images, overview, what's in/out, itinerary, policies.
function AgencyTourPreview({ info, departure, isPackage: pkg }) {
  const cities = info.cities || [info.city];
  const included = info.included || [];
  const notIncluded = info.notIncluded || [];
  const itinerary = info.itinerary || [];
  const cover = coverImage(info);
  return (
    <section className="panel agency-tour" id="tour-details">
      <div className="agency-tour-head">
        <div className="agency-tour-cover" style={{ backgroundImage: `url(${cover})` }} />
        <div className="agency-tour-intro">
          <div className="agency-tour-title">
            <h2>{info.title || departure.route}</h2>
            {pkg && <span className="type-badge"><Package size={11} />Package</span>}
          </div>
          <p className="agency-tour-meta">
            <MapPin size={14} />{pkg ? cities.join(" → ") : info.city}
            {info.duration ? ` · ${info.duration}` : ""}
            {info.guide ? ` · ${info.guide}` : ""}
          </p>
          <div className="agency-tour-facts">
            <span><CalendarDays size={14} />{pkg
              ? formatRange(departure.startDate || departure.date, departure.endDate)
              : `${formatDate(departure.date)}${departure.time ? ` · ${departure.time}` : ""}`}</span>
            <span><Car size={14} />{info.vehicle || "Shared vehicle"}</span>
            {info.bookingCutoffHours != null && <span><Clock3 size={14} />Cutoff {cutoffLabel(info.bookingCutoffHours, info.bookingCutoffUnit)}</span>}
          </div>
        </div>
      </div>

      <RichBlock html={info.overviewHtml} fallback={info.description || departure.notes} />

      <div className="included-grid agency-incl">
        <div>
          <h3>What's included</h3>
          {included.length ? included.map((x) => <p key={x}><Check size={15} />{x}</p>)
            : <p className="muted-line">Not specified.</p>}
        </div>
        <div>
          <h3>Not included</h3>
          {notIncluded.length ? notIncluded.map((x) => <p key={x}><ChevronDown size={15} />{x}</p>)
            : <p className="muted-line">—</p>}
        </div>
      </div>

      {pkg && itinerary.length > 0 && (
        <div className="itinerary-block">
          <h3>Day-by-day itinerary</h3>
          <ol className="itinerary-list">
            {itinerary.map((day, i) => (
              <li key={day.day || i}>
                <div className="itinerary-day">Day {day.day || i + 1} · {day.city}</div>
                <strong>{day.title}</strong>
                {day.description && /<\w+/.test(day.description)
                  ? <div className="rich" dangerouslySetInnerHTML={{ __html: day.description }} />
                  : day.description ? <p>{day.description}</p> : null}
                <small>Meals: {day.meals || "—"}</small>
              </li>
            ))}
          </ol>
        </div>
      )}

      <TourExtras product={info} />
    </section>
  );
}

function AgencyDesk(props) {
  const {
    agencyId, agencies, cancelPledge, createDeparture, customerName, filtered, isConfirmed, isSaving, newRoute, newSeats,
    selected, selectedProduct, selectedRate, selectedSeats, goAheadSelected, roomingType, setRoomingType, tierId, setTierId,
    setAgencyId, setCustomerName, setNewRoute, setNewSeats, setQuery, setSeatCount,
    setSelectedId, seatCount, query, addPledge,
  } = props;
  const selectedIsPackage = isPackage(selected);
  const tiers = selectedProduct?.accommodationTiers || [];
  // Full tour info the agency is selling — prefer the rich product record,
  // fall back to the departure's own fields for ad-hoc pooling requests.
  const info = selectedProduct || selected;

  return (
    <>
      <section className="main-grid">
        <div className="panel board" id="departures">
          <div className="panel-header">
            <div>
              <h2>Open pooled departures</h2>
              <p>Day tours and packages. Find ones that need a few more travelers to reach the published rate.</p>
            </div>
            <div className="search-box">
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search route or city" aria-label="Search departures" />
            </div>
          </div>

          <div className="toolbar">
            <button><Filter size={16} />Date</button>
            <button><ShieldCheck size={16} />Status</button>
            <button><ChevronDown size={16} />Seats needed</button>
          </div>

          <div className="departure-list">
            {filtered.map((departure) => {
              const seats = seatsTotal(departure.pledges);
              const ga = goAheadSeatsFor(departure);
              const dIsPackage = isPackage(departure);
              return (
                <button key={departure.id} className={`departure-row ${selected.id === departure.id ? "selected" : ""}`} onClick={() => setSelectedId(departure.id)}>
                  <div className="date-tile">
                    <span>{formatDate(departure.date).split(",")[0]}</span>
                    <strong>{formatDate(departure.date).split(" ")[1]}</strong>
                  </div>
                  <div className="departure-copy">
                    <div className="row-title">
                      <strong>
                        {dIsPackage && <span className="type-badge"><Package size={11} />Package</span>}
                        {departure.route}
                      </strong>
                      <span className={isGoAheadDeparture(departure) ? "status ok" : "status"}>{departureStatusLabel(departure)}</span>
                    </div>
                    <p>
                      <MapPin size={14} />
                      {dIsPackage
                        ? `${(departure.cities || [departure.city]).join(" → ")} · ${formatRange(departure.startDate || departure.date, departure.endDate)}`
                        : `${departure.city} at ${departure.time}`}
                    </p>
                    <div className="progress" aria-label={`${seats} of ${ga} seats`}>
                      <span style={{ width: `${Math.min(100, (seats / ga) * 100)}%` }} />
                    </div>
                  </div>
                  <div className="rate-block">
                    <strong>{CURRENCY_SYMBOL}{rateFor(departure)}</strong>
                    <span>{dIsPackage ? "from /pp" : "live rate"}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <aside className="panel join-panel">
          <div className="panel-header compact">
            <div>
              <h2>Join this group</h2>
              <p>{selected.route}</p>
            </div>
            <span className={isConfirmed ? "status ok" : "status"}>{departureStatusLabel(selected)}</span>
          </div>

          <div className="capacity">
            <div><span>Committed seats</span><strong>{selectedSeats}/{selected.maxSeats}</strong></div>
            <div><span>GoAhead at</span><strong>{goAheadSelected}</strong></div>
          </div>

          <form className="join-form" onSubmit={addPledge}>
            <label>
              Seats to add
              <input type="number" min="1" max={Math.max(1, selected.maxSeats - selectedSeats)} value={seatCount} onChange={(event) => setSeatCount(event.target.value)} />
            </label>
            {selectedIsPackage && (
              <>
                <label>
                  Hotel tier
                  <select value={tierId} onChange={(event) => setTierId(event.target.value)}>
                    {tiers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}{t.perPersonSupplement ? ` (+/pp)` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Room type
                  <select value={roomingType} onChange={(event) => setRoomingType(event.target.value)}>
                    <option value="single">Single</option>
                    <option value="double">Double / twin</option>
                    <option value="triple">Triple</option>
                  </select>
                </label>
              </>
            )}
            <label>
              Customer reference
              <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Name, party, voucher ID" />
            </label>
            <button className="primary full" type="submit" disabled={isSaving}><Check size={18} />{isSaving ? "Saving..." : "Pledge seats"}</button>
          </form>

          <div className="rate-card" id="pricing">
            <div><span>{selectedIsPackage ? "Price per person" : "Shared live rate"}</span><strong>{CURRENCY_SYMBOL}{selectedRate}</strong></div>
            <div><span>Break price</span><strong>{CURRENCY_SYMBOL}{selected.breakPrice || Math.round(selected.publishedRate * 0.8)}</strong></div>
            <p>
              {selectedIsPackage
                ? `${selected.depositPercent || 20}% deposit confirms each booking. Hotel tier and single supplement are included above.`
                : selectedSeats < goAheadSelected
                  ? "GoAhead price starts when minimum seats are reached, then drops as the group grows."
                  : `Minimum seats reached. ${selected.depositPercent || 10}% deposit per reservation, balance due one day before departure.`}
            </p>
          </div>
        </aside>
      </section>

      <AgencyTourPreview info={info} departure={selected} isPackage={selectedIsPackage} />

      <section className="bottom-grid">
        <div className="panel" id="manifest">
          <div className="panel-header">
            <div><h2>Shared manifest</h2><p>One vehicle, one guide, separate agency ownership.</p></div>
            {/* The rule the server actually enforces (bookingClosed), not the
                free-text label departures used to carry — which said "Open
                until 18:00" while the system closed 24h before start. */}
            <span className="pill"><Clock3 size={15} />Cutoff {cutoffLabel(info.bookingCutoffHours ?? 24, info.bookingCutoffUnit)}</span>
          </div>
          <div className="manifest-list">
            {selected.pledges.map((pledge, index) => (
              <div className="manifest-item" key={pledge.id || `${pledge.agency}-${index}`}>
                <span>{index + 1}</span>
                <div>
                  <strong>{pledge.agency}</strong>
                  <p>{pledge.customers}</p>
                  {selectedIsPackage && pledge.accommodationTierName && (
                    <p className="manifest-sub">{pledge.accommodationTierName} · {pledge.roomingType || "double"} room</p>
                  )}
                  {pledge.depositDue && <p>{CURRENCY_SYMBOL}{pledge.depositDue} deposit · {CURRENCY_SYMBOL}{pledge.balanceDue} balance</p>}
                </div>
                <b>{pledge.seats} seat{pledge.seats > 1 ? "s" : ""}</b>
                {pledge.agencyId === agencyId && selected.status !== "supplier_confirmed" && (
                  <button className="danger-icon" onClick={() => cancelPledge(pledge.id)} aria-label={`Cancel ${pledge.customers}`}><Trash2 size={16} /></button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="panel create-panel" id="create-request">
          <div className="panel-header">
            <div><h2>Create pooling request</h2><p>Start a day-tour departure when you have a booking but not enough travelers. For multi-day packages, ask the admin to publish a date.</p></div>
            <Sparkles size={20} />
          </div>
          <form className="create-form" onSubmit={createDeparture}>
            <input value={newRoute} onChange={(event) => setNewRoute(event.target.value)} placeholder="Tour route, e.g. Cairo sunset visit" aria-label="New route" />
            <input value={newSeats} min="2" max={MAX_GROUP_SIZE} type="number" onChange={(event) => setNewSeats(event.target.value)} aria-label="Minimum seats" />
            <button className="primary" type="submit" disabled={isSaving}><Plus size={18} />{isSaving ? "Saving..." : "Publish"}</button>
          </form>
          <div className="supplier-strip">
            <span><CalendarDays size={16} />Auto cutoff</span>
            <span><Car size={16} />Vehicle match</span>
            <span><ShieldCheck size={16} />Safety check</span>
          </div>
        </div>

        <div className="panel messages" id="messages">
          <h2>Coordination</h2>
          <div className="message">
            <strong>Supplier desk</strong>
            <p>{isConfirmed ? "Minimum seats reached. Holding vehicle and guide for final confirmation." : `Need ${goAheadSelected - selectedSeats} more seat${goAheadSelected - selectedSeats > 1 ? "s" : ""} before cutoff.`}</p>
          </div>
          <div className="message muted">
            <strong>Customer promise</strong>
            <p>Agency names stay separate on vouchers. Travelers meet at shared pickup points only after confirmation.</p>
          </div>
        </div>
      </section>
    </>
  );
}

export {
  AdminDashboard, AgencyDashboard, OperatorDashboard, Portal, roleLabel, StaffPanel, AgencyTourPreview,
  AgencyDesk,
};
