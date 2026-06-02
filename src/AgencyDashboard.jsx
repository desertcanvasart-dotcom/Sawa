import React, { useMemo, useState } from "react";
import {
  LayoutDashboard, Ticket, ClipboardList, Users as UsersIcon, ShieldCheck, ArrowUpRight,
  Check, AlertTriangle, CalendarDays,
} from "lucide-react";
import { DashSidebar } from "./DashSidebar";

const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString());
const fmtDate = (d) => (d ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(d)) : "—");
const seatsOf = (d) => (d.pledges || []).reduce((s, p) => s + Number(p.seats || 0), 0);

// Receives the existing AgencyDesk + StaffPanel as render components so it can
// reuse all the booking logic already wired in main.jsx without duplicating it.
export function AgencyDashboard({ user, agency, signOut, navigate, departures, agencyDeskProps, AgencyDesk, StaffPanel }) {
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
          <>
            <div className="dash-head"><div><h1>Book seats</h1><p>Find a forming date and add your travellers.</p></div></div>
            <div className="agency-embed">
              {agencyDeskProps.selected && <AgencyDesk {...agencyDeskProps} />}
            </div>
          </>
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

function Kpi({ icon: Icon, label, value, foot, accent }) {
  return (
    <div className={`kpi ${accent ? "kpi-accent" : ""}`}>
      <div className="kpi-top"><Icon size={18} strokeWidth={2} /><span>{label}</span></div>
      <strong>{value}</strong>
      {foot && <p>{foot}</p>}
    </div>
  );
}
