import React, { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard, Package, CalendarDays, Users, ClipboardList, ScrollText,
  Plus, Check, X, Search, Archive, ArchiveRestore, CircleDollarSign, ShieldCheck,
  TrendingUp, AlertTriangle, MapPin, Hotel, ArrowUpRight, ArrowLeft, Trash2, Pencil,
  Newspaper, Share2, Copy, Inbox, Eye, Clock3,
} from "lucide-react";
import { apiFetch, supabase, uploadImage } from "./supabaseClient";
import { DashSidebar } from "./DashSidebar";
import { RichText } from "./RichText";
// Date-only departure values need a local-noon anchor or they render a day
// early west of UTC — see src/dates.js.
import { fmtDate } from "./dates.js";

const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString());
const isPkg = (x) => x?.type === "package";

// Meeting points are now managed per-destination (Destinations section) and the
// tour editor reads them from the selected destination.
const samePoint = (a, b) => a.point === b.point && a.note === b.note;
// Cancelled pledges have released their seats — excluded here so the dashboard
// agrees with the server (domain.js) and with the Bookings tab's own totals.
const seatsOf = (d) => (d.pledges || []).reduce((s, p) => (p?.status === "cancelled" ? s : s + Number(p.seats || 0)), 0);
const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// Minimal flat navigation. One group, no header. Departures keeps a subtle
// alert dot when items are ready to confirm (the one thing worth surfacing).
const NAV_GROUPS = [
  {
    title: null,
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
      { id: "tours", label: "Tours & Packages", icon: Package },
      { id: "archive", label: "Archive", icon: Archive },
      { id: "listings", label: "Listing requests", icon: Inbox, alert: (s) => s?.pendingListings || 0 },
      { id: "daterequests", label: "Date requests", icon: Clock3 },
      { id: "destinations", label: "Destinations", icon: MapPin },
      { id: "blog", label: "Blog", icon: Newspaper },
      { id: "departures", label: "Departures", icon: CalendarDays, alert: (s) => s?.departureStatus?.readyToConfirm || 0 },
      { id: "bookings", label: "Bookings", icon: ClipboardList },
      { id: "referrals", label: "Referrals", icon: Share2 },
      { id: "agencies", label: "Agencies", icon: Users },
      { id: "team", label: "Operations team", icon: ShieldCheck },
      { id: "activity", label: "Activity", icon: ScrollText },
    ],
  },
];

export function AdminDashboard({ user, agency, signOut, navigate }) {
  const [section, setSection] = useState("overview");
  const [data, setData] = useState(null);       // bootstrap
  const [stats, setStats] = useState(null);
  const [destinations, setDestinations] = useState([]);
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");

  async function loadAll() {
    setLoading(true);
    try {
      const okJson = (r) => (r.ok ? r.json() : Promise.reject(new Error(`Request failed (${r.status})`)));
      const [boot, st, dest, blog] = await Promise.all([
        apiFetch("/bootstrap").then(okJson),
        apiFetch("/admin/stats").then(okJson),
        apiFetch("/admin/destinations").then(okJson).catch(() => ({ destinations: [] })),
        apiFetch("/admin/blog").then(okJson).catch(() => ({ posts: [] })),
      ]);
      setData(boot);
      setStats(st);
      setDestinations(dest.destinations || []);
      setPosts(blog.posts || []);
    } catch (e) {
      setNotice("Could not load dashboard data.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { loadAll(); }, []);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(""), 4000); };

  return (
    <div className="dash">
      <DashSidebar
        subtitle="Operations"
        groups={NAV_GROUPS}
        active={section}
        onSelect={setSection}
        stats={stats}
        roleLabel={user.role === "super_admin" ? "Super admin" : "Operations"}
        user={user}
        navigate={navigate}
        signOut={signOut}
      />

      <main className="dash-main">
        {notice && <div className="dash-flash" role="status">{notice}</div>}
        {loading && <DashSkeleton />}
        {!loading && data && (
          <>
            {section === "overview" && <Overview stats={stats} data={data} onGo={setSection} />}
            {section === "tours" && <ToursSection data={data} destinations={destinations} reload={loadAll} flash={flash} />}
            {section === "archive" && <ArchiveSection data={data} reload={loadAll} flash={flash} />}
            {section === "listings" && <ListingRequestsSection data={data} reload={loadAll} flash={flash} />}
            {section === "daterequests" && <DateRequestsSection data={data} reload={loadAll} flash={flash} />}
            {section === "destinations" && <DestinationsSection destinations={destinations} reload={loadAll} flash={flash} />}
            {section === "blog" && <BlogSection posts={posts} reload={loadAll} flash={flash} />}
            {section === "departures" && <DeparturesSection data={data} reload={loadAll} flash={flash} />}
            {section === "bookings" && <BookingsSection data={data} stats={stats} />}
            {section === "referrals" && <ReferralsSection flash={flash} />}
            {section === "agencies" && <AgenciesSection flash={flash} />}
            {section === "team" && <OpsTeamSection flash={flash} currentUserId={user.id} />}
            {section === "activity" && <ActivitySection />}
          </>
        )}
      </main>
    </div>
  );
}

function DashSkeleton() {
  return (
    <div className="dash-skeleton">
      <div className="sk-row" /><div className="sk-grid"><i /><i /><i /><i /></div><div className="sk-block" />
    </div>
  );
}

function PageHead({ title, sub, action }) {
  return (
    <div className="dash-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {action}
    </div>
  );
}

/* ---------------- Overview ---------------- */
function Overview({ stats, data, onGo }) {
  const t = stats?.totals || {};
  const s = stats?.departureStatus || {};
  return (
    <>
      <PageHead title="Overview" sub="Everything happening across Sawa right now." />
      <div className="kpi-grid">
        <Kpi icon={ClipboardList} label="Total bookings" value={t.bookings ?? 0} foot={`${t.bookingsThisWeek ?? 0} in the last 7 days`} />
        <Kpi icon={TrendingUp} label="Booking value" value={money(t.revenue)} foot={`${money(t.depositsDue)} deposits`} accent />
        <Kpi icon={Users} label="Seats pooled" value={t.seatsPooled ?? 0} foot={`${t.agencies ?? 0} active agencies`} />
        <Kpi icon={Package} label="Products" value={(t.dayTours ?? 0) + (t.packages ?? 0)} foot={`${t.dayTours ?? 0} tours · ${t.packages ?? 0} packages`} />
      </div>

      <div className="dash-two">
        <div className="dash-card">
          <div className="dash-card-head"><h2>Departures needing action</h2><button className="link-btn" onClick={() => onGo("departures")}>View all <ArrowUpRight size={14} /></button></div>
          <div className="status-rows">
            <StatusRow tone="warn" icon={AlertTriangle} label="At risk (≤14 days, under min seats)" value={s.atRisk ?? 0} />
            <StatusRow tone="go" icon={Check} label="Ready to confirm" value={s.readyToConfirm ?? 0} />
            <StatusRow tone="muted" icon={CalendarDays} label="Open & forming" value={s.open ?? 0} />
            <StatusRow tone="ok" icon={ShieldCheck} label="Confirmed (GoAhead)" value={s.confirmed ?? 0} />
          </div>
        </div>

        <div className="dash-card">
          <div className="dash-card-head"><h2>Top forming departures</h2><button className="link-btn" onClick={() => onGo("departures")}>View all <ArrowUpRight size={14} /></button></div>
          <div className="mini-list">
            {[...data.departures]
              .filter((d) => d.status !== "cancelled")
              .sort((a, b) => seatsOf(b) - seatsOf(a)).slice(0, 5)
              .map((d) => {
                const seats = seatsOf(d), min = d.minSeats || 4;
                return (
                  <div className="mini-row" key={d.id}>
                    <div><strong>{d.route}</strong><span>{d.city} · {fmtDate(d.startDate || d.date)}</span></div>
                    <div className="mini-meter"><i style={{ width: `${Math.min(100, (seats / min) * 100)}%` }} /></div>
                    <b>{seats}/{min}</b>
                  </div>
                );
              })}
            {data.departures.length === 0 && <Empty label="No departures yet." />}
          </div>
        </div>
      </div>
    </>
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
function StatusRow({ tone, icon: Icon, label, value }) {
  return <div className={`status-line ${tone}`}><Icon size={16} /><span>{label}</span><b>{value}</b></div>;
}
function Empty({ label }) { return <div className="dash-empty">{label}</div>; }

/* ---------------- Tours & Packages ---------------- */
function ToursSection({ data, destinations = [], reload, flash }) {
  const [editor, setEditor] = useState(null); // null | {type}
  // Only what's on sale. Archived listings live in their own sidebar section —
  // mixed into this list they read as clutter, and made it look as if a
  // cancelled tour was still being sold.
  const products = (data.tourProducts || []).filter((p) => p.active !== false);

  async function archive(p) {
    const r = await apiFetch(`/admin/tour-products/${p.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    if (r.ok) { flash("Tour archived — find it under Archive in the sidebar."); reload(); }
  }

  // Full-page editor takes over the section when adding/editing.
  if (editor) {
    return (
      <ProductEditor
        type={editor.type}
        existing={editor.existing}
        destinations={destinations}
        departures={data.departures || []}
        onClose={() => setEditor(null)}
        onSaved={() => { setEditor(null); flash(editor.existing ? "Tour updated." : "Tour created."); reload(); }}
      />
    );
  }

  return (
    <>
      <PageHead title="Tours & Packages" sub="Create and manage the products agencies and travellers can book."
        action={
          <div className="head-actions">
            <button className="btn-ghost" onClick={() => setEditor({ type: "day_tour" })}><Plus size={16} />Add tour</button>
            <button className="btn-primary" onClick={() => setEditor({ type: "package" })}><Plus size={16} />Add package</button>
          </div>
        } />

      <div className="table-wrap">
        <table className="dash-table">
          <thead><tr><th>Name</th><th>Type</th><th>City</th><th>GoAhead</th><th>Break</th><th>Min</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.title}</strong></td>
                <td>{isPkg(p) ? <span className="tag tag-pkg">Package</span> : <span className="tag">Day tour</span>}</td>
                <td>{isPkg(p) ? (p.cities || [p.city]).join(" → ") : p.city}</td>
                <td>{money(p.publishedRate)}</td>
                <td>{money(p.breakPrice)}</td>
                <td>{p.minSeats}</td>
                <td><span className="tag tag-on">Active</span></td>
                <td className="row-actions">
                  <button className="icon-btn" title="Edit" onClick={() => setEditor({ existing: p })}><Pencil size={15} /></button>
                  <button className="icon-btn" title="Archive" onClick={() => archive(p)}><Archive size={15} /></button>
                </td>
              </tr>
            ))}
            {products.length === 0 && <tr><td colSpan={8}><Empty label="No products yet. Add your first tour or package." /></td></tr>}
          </tbody>
        </table>
      </div>

    </>
  );
}

/* ---------------- Archive (retired listings) ---------------- */
function ArchiveSection({ data, reload, flash }) {
  const products = (data.tourProducts || []).filter((p) => p.active === false);

  async function restore(p) {
    const r = await apiFetch(`/admin/tour-products/${p.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    if (r.ok) { flash("Tour restored — it's back under Tours & Packages."); reload(); }
  }

  return (
    <>
      <PageHead title="Archive" sub="Retired and cancelled listings. Nothing here is visible to customers or agencies — restore one to put it back on sale." />
      <div className="table-wrap">
        <table className="dash-table">
          <thead><tr><th>Name</th><th>Type</th><th>City</th><th>GoAhead</th><th>Break</th><th>Min</th><th></th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="row-archived">
                <td><strong>{p.title}</strong></td>
                <td>{isPkg(p) ? <span className="tag tag-pkg">Package</span> : <span className="tag">Day tour</span>}</td>
                <td>{isPkg(p) ? (p.cities || [p.city]).join(" → ") : p.city}</td>
                <td>{money(p.publishedRate)}</td>
                <td>{money(p.breakPrice)}</td>
                <td>{p.minSeats}</td>
                <td className="row-actions">
                  <button className="icon-btn" title="Restore" onClick={() => restore(p)}><ArchiveRestore size={15} /></button>
                </td>
              </tr>
            ))}
            {products.length === 0 && <tr><td colSpan={7}><Empty label="The archive is empty. Archiving a tour from Tours & Packages moves it here." /></td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------- Destinations ---------------- */
function DestinationsSection({ destinations, reload, flash }) {
  const [editor, setEditor] = useState(null); // null | {} | { existing }

  async function remove(d) {
    if (!window.confirm(`Delete "${d.name}"? Tours that already saved its meeting points keep them.`)) return;
    const r = await apiFetch(`/admin/destinations/${d.id}`, { method: "DELETE" });
    if (r.ok) { flash("Destination deleted."); reload(); }
  }

  return (
    <>
      <PageHead
        title="Destinations"
        sub="Cities travellers can book in. Each destination owns its meeting points — tours pick a destination and inherit them."
        action={<button className="btn-primary" onClick={() => setEditor({})}><Plus size={16} />Add destination</button>}
      />
      <div className="table-wrap">
        <table className="dash-table">
          <thead><tr><th>Name</th><th>Meeting points</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {destinations.map((d) => (
              <tr key={d.id}>
                <td><strong>{d.name}</strong></td>
                <td>{(d.meetingPoints?.length || 0)} {(d.meetingPoints?.length || 0) === 1 ? "point" : "points"}</td>
                <td>{d.active === false ? <span className="tag tag-off">Hidden</span> : <span className="tag tag-on">Active</span>}</td>
                <td className="row-actions">
                  <button className="icon-btn" title="Edit" onClick={() => setEditor({ existing: d })}><Pencil size={15} /></button>
                  <button className="icon-btn" title="Delete" onClick={() => remove(d)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
            {destinations.length === 0 && <tr><td colSpan={4}><Empty label="No destinations yet. Add your first city." /></td></tr>}
          </tbody>
        </table>
      </div>
      {editor && (
        <DestinationEditor
          existing={editor.existing}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); flash("Destination saved."); reload(); }}
        />
      )}
    </>
  );
}

function DestinationEditor({ existing, onClose, onSaved }) {
  const [name, setName] = useState(existing?.name || "");
  const [active, setActive] = useState(existing?.active !== false);
  const [points, setPoints] = useState(existing?.meetingPoints?.length ? existing.meetingPoints : [{ point: "", note: "" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setErr("");
    if (!name.trim()) return setErr("Destination name is required.");
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        active,
        meetingPoints: points.map((p) => ({ point: (p.point || "").trim(), note: (p.note || "").trim() })).filter((p) => p.point),
      };
      if (existing?.id) body.id = existing.id;
      const r = await apiFetch("/admin/destinations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save.");
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{existing ? "Edit destination" : "New destination"}</h2>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <Field label="Destination name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alexandria" /></Field>
          <label className="dest-toggle">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>Visible to travellers</span>
          </label>
          <div className="modal-subhead dest-mp-head"><h3>Meeting points</h3><button type="button" className="btn-ghost sm" onClick={() => setPoints((p) => [...p, { point: "", note: "" }])}><Plus size={14} />Add meeting point</button></div>
          {points.map((p, i) => (
            <div className="itin-row" key={i}>
              <input placeholder="Location (e.g. In front of the Egyptian Museum, Tahrir)" value={p.point} onChange={(e) => setPoints((ps) => ps.map((x, j) => j === i ? { ...x, point: e.target.value } : x))} />
              <input placeholder="Time note (Be there by 8:00 AM / Departs 7:30 AM)" value={p.note} onChange={(e) => setPoints((ps) => ps.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} />
              <button type="button" className="icon-btn" onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
          {err && <p className="dest-err">{err}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save destination"}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Blog ---------------- */
function BlogSection({ posts, reload, flash }) {
  const [editor, setEditor] = useState(null); // null | {} | { existing }

  async function remove(p) {
    if (!window.confirm(`Delete "${p.title}"? This can't be undone.`)) return;
    const r = await apiFetch(`/admin/blog/${p.id}`, { method: "DELETE" });
    if (r.ok) { flash("Post deleted."); reload(); }
  }

  if (editor) {
    return <BlogEditor existing={editor.existing} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); flash("Post saved."); reload(); }} />;
  }

  return (
    <>
      <PageHead
        title="Blog"
        sub="Write articles with a what-you-see-is-what-you-get editor, plus full SEO and AI / GEO optimization."
        action={<button className="btn-primary" onClick={() => setEditor({})}><Plus size={16} />New post</button>}
      />
      <div className="table-wrap">
        <table className="dash-table">
          <thead><tr><th>Title</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.title}</strong><div className="sub">/blog/{p.slug}</div></td>
                <td>{p.status === "published" ? <span className="tag tag-on">Published</span> : <span className="tag tag-off">Draft</span>}</td>
                <td>{fmtDate(p.updatedAt)}</td>
                <td className="row-actions">
                  <button className="icon-btn" title="Edit" onClick={() => setEditor({ existing: p })}><Pencil size={15} /></button>
                  <button className="icon-btn" title="Delete" onClick={() => remove(p)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
            {posts.length === 0 && <tr><td colSpan={4}><Empty label="No posts yet. Write your first article." /></td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BlogEditor({ existing, onClose, onSaved }) {
  const editing = !!existing;
  const [slugTouched, setSlugTouched] = useState(!!existing?.slug);
  const [f, setF] = useState({
    title: existing?.title || "", slug: existing?.slug || "", excerpt: existing?.excerpt || "",
    coverImage: existing?.coverImage || "", author: existing?.author || "Sawa Tours",
    authorCredentials: existing?.authorCredentials || "", tags: (existing?.tags || []).join(", "),
    metaTitle: existing?.metaTitle || "", metaDescription: existing?.metaDescription || "",
    keywords: (existing?.keywords || []).join(", "), canonicalUrl: existing?.canonicalUrl || "",
    ogImage: existing?.ogImage || "", noindex: existing?.noindex || false,
    tldr: existing?.tldr || "", geoRegion: existing?.geoRegion || "", geoPlace: existing?.geoPlace || "",
    geoLat: existing?.geoLat || "", geoLng: existing?.geoLng || "", localKeywords: (existing?.localKeywords || []).join(", "),
  });
  const [bodyHtml, setBodyHtml] = useState(existing?.bodyHtml || "");
  const [keyTakeaways, setKeyTakeaways] = useState(existing?.keyTakeaways?.length ? existing.keyTakeaways : [""]);
  const [faq, setFaq] = useState(existing?.faq?.length ? existing.faq : [{ q: "", a: "" }]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState("");
  const [err, setErr] = useState("");

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const onTitle = (e) => setF((s) => ({ ...s, title: e.target.value, slug: slugTouched ? s.slug : slugify(e.target.value) }));
  const onSlug = (e) => { setSlugTouched(true); setF((s) => ({ ...s, slug: slugify(e.target.value) })); };

  async function pickImage(e, field) {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(field); setErr("");
    try { const url = await uploadImage(file); setF((s) => ({ ...s, [field]: url })); }
    catch (e2) { setErr(e2.message); } finally { setUploading(""); }
  }

  async function save(status) {
    setErr("");
    if (!f.title.trim()) return setErr("Title is required.");
    setBusy(true);
    try {
      const body = {
        ...(existing?.id ? { id: existing.id } : {}),
        title: f.title.trim(), slug: (f.slug || slugify(f.title)).trim(), excerpt: f.excerpt.trim(),
        coverImage: f.coverImage, bodyHtml, author: f.author.trim(), authorCredentials: f.authorCredentials.trim(),
        tags: csv(f.tags), status,
        metaTitle: f.metaTitle.trim(), metaDescription: f.metaDescription.trim(), keywords: csv(f.keywords),
        canonicalUrl: f.canonicalUrl.trim(), ogImage: f.ogImage, noindex: f.noindex,
        tldr: f.tldr.trim(), keyTakeaways: keyTakeaways.map((x) => x.trim()).filter(Boolean),
        faq: faq.map((x) => ({ q: (x.q || "").trim(), a: (x.a || "").trim() })).filter((x) => x.q),
        geoRegion: f.geoRegion.trim(), geoPlace: f.geoPlace.trim(), geoLat: f.geoLat.trim(), geoLng: f.geoLng.trim(),
        localKeywords: csv(f.localKeywords),
      };
      const r = await apiFetch("/admin/blog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save.");
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const ImageField = ({ label, field, hint }) => (
    <Field label={label} full>
      <div className="blog-img">
        {f[field] ? <img src={f[field]} alt="" /> : <div className="blog-img-empty">No image</div>}
        <div className="blog-img-actions">
          <label className="btn-ghost sm">{uploading === field ? "Uploading…" : "Upload"}<input type="file" accept="image/*" hidden onChange={(e) => pickImage(e, field)} /></label>
          {f[field] && <button type="button" className="btn-ghost sm" onClick={() => setF((s) => ({ ...s, [field]: "" }))}>Remove</button>}
          {hint && <span className="field-hint">{hint}</span>}
        </div>
      </div>
    </Field>
  );

  return (
    <div className="editor-page">
      <div className="editor-page-head">
        <button className="editor-back" onClick={onClose}><ArrowLeft size={16} />Back to Blog</button>
        <h1>{editing ? "Edit post" : "New post"}</h1>
      </div>

      <div className="editor-page-body blog-editor">
        <div className="modal-subhead"><h3>Content</h3></div>
        <div className="form-grid">
          <Field label="Title" full><input value={f.title} onChange={onTitle} placeholder="Why shared tours actually run" /></Field>
          <Field label="URL slug"><input value={f.slug} onChange={onSlug} placeholder="why-shared-tours-run" /></Field>
          <Field label="Tags (comma-separated)"><input value={f.tags} onChange={set("tags")} placeholder="Egypt, Travel tips" /></Field>
          <Field label="Excerpt (card + meta fallback)" full><textarea rows={2} value={f.excerpt} onChange={set("excerpt")} placeholder="One or two sentences shown on the blog card and in search results." /></Field>
        </div>
        <ImageField label="Cover image" field="coverImage" hint="Recommended ~1600px wide, JPG." />
        <Field label="Article body" full asDiv><RichText value={bodyHtml} onChange={setBodyHtml} placeholder="Write your article — headings, bold, lists, links…" /></Field>
        <div className="form-grid">
          <Field label="Author"><input value={f.author} onChange={set("author")} placeholder="Sawa Tours" /></Field>
          <Field label="Author credentials (E-E-A-T)"><input value={f.authorCredentials} onChange={set("authorCredentials")} placeholder="Licensed Egyptologist · 10 years guiding" /></Field>
        </div>

        <div className="modal-subhead"><h3>SEO</h3></div>
        <div className="form-grid">
          <Field label="Meta title" full><input value={f.metaTitle} onChange={set("metaTitle")} placeholder="Defaults to the post title" /></Field>
          <Field label="Meta description" full><textarea rows={2} value={f.metaDescription} onChange={set("metaDescription")} placeholder="~150–160 characters for search snippets (defaults to the excerpt)." /></Field>
          <Field label="Focus keywords (comma-separated)"><input value={f.keywords} onChange={set("keywords")} placeholder="aswan day tour, philae temple" /></Field>
          <Field label="Canonical URL"><input value={f.canonicalUrl} onChange={set("canonicalUrl")} placeholder="https://sawa.tours/blog/…" /></Field>
        </div>
        <ImageField label="Social share image (Open Graph)" field="ogImage" hint="Defaults to the cover image. ~1200×630." />
        <label className="dest-toggle"><input type="checkbox" checked={f.noindex} onChange={set("noindex")} /><span>Hide from search engines (noindex)</span></label>

        <div className="modal-subhead"><h3>AI / Generative Engine (GEO)</h3></div>
        <Field label="TL;DR — short answer for AI engines" full><textarea rows={2} value={f.tldr} onChange={set("tldr")} placeholder="A 1–2 sentence direct answer AI assistants can quote." /></Field>
        <RowList label="Key takeaways" rows={keyTakeaways} setRows={setKeyTakeaways} placeholder="A concise, quotable fact" />
        <div className="modal-subhead sub"><h3>FAQ (structured data)</h3><button type="button" className="btn-ghost sm" onClick={() => setFaq((q) => [...q, { q: "", a: "" }])}><Plus size={14} />Add question</button></div>
        {faq.map((item, i) => (
          <div className="faq-edit" key={i}>
            <input value={item.q} onChange={(e) => setFaq((q) => q.map((x, j) => j === i ? { ...x, q: e.target.value } : x))} placeholder="Question" />
            <textarea rows={2} value={item.a} onChange={(e) => setFaq((q) => q.map((x, j) => j === i ? { ...x, a: e.target.value } : x))} placeholder="Answer" />
            <button type="button" className="icon-btn" onClick={() => setFaq((q) => q.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        ))}

        <div className="modal-subhead"><h3>Location (geo)</h3></div>
        <div className="form-grid">
          <Field label="Region / city"><input value={f.geoRegion} onChange={set("geoRegion")} placeholder="Aswan, Egypt" /></Field>
          <Field label="Place name"><input value={f.geoPlace} onChange={set("geoPlace")} placeholder="Philae Temple" /></Field>
          <Field label="Latitude"><input value={f.geoLat} onChange={set("geoLat")} placeholder="24.0254" /></Field>
          <Field label="Longitude"><input value={f.geoLng} onChange={set("geoLng")} placeholder="32.8844" /></Field>
          <Field label="Local keywords (comma-separated)" full><input value={f.localKeywords} onChange={set("localKeywords")} placeholder="things to do in aswan, aswan tours" /></Field>
        </div>

        {err && <div className="auth-error" role="alert">{err}</div>}
      </div>

      <div className="editor-page-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <div className="wiz-nav">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => save("draft")}>{busy ? "Saving…" : "Save draft"}</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => save("published")}>{busy ? "Saving…" : "Publish"}</button>
        </div>
      </div>
    </div>
  );
}

const STEPS = ["Details", "Content", "Itinerary", "Dates"];

export function ProductEditor({ type: typeProp, existing, destinations = [], departures = [], onClose, onSaved, saveEndpoint = "/admin/tour-products", agencyMode = false }) {
  const editing = !!existing;
  const type = existing?.type || typeProp;
  const pkg = type === "package";
  const [step, setStep] = useState(0);
  // Agencies submit a listing for review — they don't publish live departure
  // dates themselves, so drop the "Dates" step for them.
  const steps = agencyMode ? STEPS.slice(0, 3) : STEPS;

  const firstDest = destinations.find((d) => d.active !== false)?.name || destinations[0]?.name || "Cairo";
  const [f, setF] = useState({
    title: existing?.title || "",
    city: existing?.city || firstDest,
    cities: (existing?.cities || ["Cairo", "Luxor"]).join(", "),
    nights: existing?.nights || 3,
    duration: existing?.duration || "",
    guide: existing?.guide || "Licensed Egyptologist",
    vehicle: existing?.vehicle || (pkg ? "Private van + flights" : "Van, 12 seats"),
    minSeats: existing?.minSeats || 4,
    maxSeats: existing?.maxSeats || 12,
    publishedRate: existing?.publishedRate || "",
    breakPrice: existing?.breakPrice || "",
    depositPercent: existing?.depositPercent || (pkg ? 20 : 10),
    description: existing?.description || "",
    meetingPoint: existing?.meetingPoint || "",
    pickupNote: existing?.pickupNote || "",
    bookingCutoffHours: existing?.bookingCutoffHours ?? 24,
    operatingDays: Array.isArray(existing?.operatingDays) ? existing.operatingDays : [],
  });
  const [meetingPoints, setMeetingPoints] = useState(() => {
    if (existing?.meetingPoints?.length) return existing.meetingPoints;
    if (existing?.meetingPoint) return [{ point: existing.meetingPoint, note: existing.pickupNote || "" }];
    return [];
  });
  const togglePreset = (preset) => setMeetingPoints((list) =>
    list.some((m) => samePoint(m, preset)) ? list.filter((m) => !samePoint(m, preset)) : [...list, preset]);
  const [overviewHtml, setOverviewHtml] = useState(existing?.overviewHtml || "");
  const [policiesHtml, setPoliciesHtml] = useState(existing?.policiesHtml || "");
  const [included, setIncluded] = useState(existing?.included?.length ? existing.included : [""]);
  const [notIncluded, setNotIncluded] = useState(existing?.notIncluded?.length ? existing.notIncluded : [""]);
  const [whatToBring, setWhatToBring] = useState(existing?.whatToBring?.length ? existing.whatToBring : [""]);
  const [images, setImages] = useState(existing?.images || []);
  // The dates step shows what is already on the calendar next to the create
  // form — the tour's published departures, soonest first.
  const scheduled = (editing ? departures.filter((d) => d.tourProductId === existing.id) : [])
    .slice()
    .sort((a, b) => String(a.startDate || a.date).localeCompare(String(b.startDate || b.date)));
  // Reorder in place; position 0 is the cover everywhere the images are read.
  const moveImage = (from, to) => setImages((a) => {
    if (to < 0 || to >= a.length) return a;
    const next = a.slice();
    const [im] = next.splice(from, 1);
    next.splice(to, 0, im);
    return next;
  });
  // Off unless the listing already has a table. The two anchors handle most
  // tours; this is for the ones whose costs step rather than slide.
  const [useTiers, setUseTiers] = useState(Boolean(existing?.priceTiers?.length));
  const [priceTiers, setPriceTiers] = useState(existing?.priceTiers || []);
  const [itinerary, setItinerary] = useState(
    existing?.itinerary?.length ? existing.itinerary
      : pkg ? [{ day: 1, city: "Cairo", title: "", description: "", meals: "Breakfast" }] : []
  );
  const [tiers, setTiers] = useState(
    existing?.accommodationTiers?.length ? existing.accommodationTiers
      : pkg ? [{ id: "standard", name: "Standard (3★)", perPersonSupplement: 0, singleSupplement: 0 }] : []
  );
  // New departures to publish on save (not for edit pre-fill). A date is
  // created together with its first booking — the traveller it belongs to —
  // so each row carries the person, not just the day.
  const newDateRow = () => ({ date: "", name: "", email: "", phone: "", seats: 1 });
  const [dates, setDates] = useState([newDateRow()]);
  const setDateRow = (i, k) => (e) => setDates((a) => a.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const clean = (arr) => arr.map((x) => x.trim()).filter(Boolean);

  // Meeting-point presets come from the selected destination (managed in the
  // Destinations section). Falls back gracefully if the city has no destination.
  const destByName = Object.fromEntries(destinations.map((d) => [d.name, d]));
  const cityPresets = destByName[f.city]?.meetingPoints || [];
  const allPresetPoints = destinations.flatMap((d) => d.meetingPoints || []);
  const cityOptions = (() => {
    const names = destinations.filter((d) => d.active !== false).map((d) => d.name);
    if (f.city && !names.includes(f.city)) names.unshift(f.city);
    return names.length ? names : ["Cairo", "Luxor", "Aswan"];
  })();

  async function handleUpload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true); setErr("");
    try {
      for (const file of files) {
        const url = await uploadImage(file);
        setImages((im) => [...im, { url, alt: f.title || "Tour image" }]);
      }
    } catch (e) { setErr(e.message); } finally { setUploading(false); }
  }

  async function save() {
    setErr("");
    if (!f.title.trim()) { setStep(0); return setErr("Title is required."); }
    if (!(Number(f.publishedRate) > 0)) { setStep(0); return setErr("GoAhead price must be a positive number."); }
    if (f.breakPrice && Number(f.breakPrice) > Number(f.publishedRate)) { setStep(0); return setErr("Break price can't exceed the GoAhead price."); }
    // Date rows are validated BEFORE the product saves, so a half-filled row
    // can't leave the product written and the dates silently dropped.
    const wantDates = agencyMode ? [] : dates.filter((r) => r.date || r.name.trim() || r.email.trim() || r.phone.trim());
    for (const r of wantDates) {
      if (!r.date || !r.name.trim() || !(r.email.trim() || r.phone.trim())) {
        setStep(steps.length - 1);
        return setErr("Each new date needs a date, the first traveller's name, and an email or phone — a date is created by its first booking.");
      }
    }
    setBusy(true);
    try {
      const body = {
        type, title: f.title.trim(), city: f.city.trim(),
        guide: f.guide, vehicle: f.vehicle,
        minSeats: Number(f.minSeats), maxSeats: Number(f.maxSeats),
        publishedRate: Number(f.publishedRate),
        breakPrice: Number(f.breakPrice || Math.round(Number(f.publishedRate) * 0.8)),
        depositPercent: Number(f.depositPercent),
        description: f.description.trim(),
        duration: f.duration.trim() || undefined,
        included: clean(included), notIncluded: clean(notIncluded), whatToBring: clean(whatToBring),
        overviewHtml, policiesHtml,
        meetingPoints: meetingPoints.map((m) => ({ point: (m.point || "").trim(), note: (m.note || "").trim() })).filter((m) => m.point),
        meetingPoint: (meetingPoints[0]?.point || f.meetingPoint || "").trim(),
        operatingDays: f.operatingDays,
        pickupNote: (meetingPoints[0]?.note || f.pickupNote || "").trim(),
        bookingCutoffHours: Number(f.bookingCutoffHours) || 0,
        images,
        // null clears any existing table, so turning the toggle off actually
        // reverts the listing to the interpolation rather than leaving a stale
        // table in place.
        priceTiers: useTiers
          ? priceTiers
              .filter((t) => String(t.price).trim() !== "")
              .map((t) => ({ seats: Number(t.seats), price: Number(t.price) }))
          : null,
      };
      if (editing) body.id = existing.id;
      if (pkg) {
        body.cities = f.cities.split(",").map((x) => x.trim()).filter(Boolean);
        body.nights = Number(f.nights);
        body.itinerary = itinerary.filter((d) => d.title.trim());
        body.accommodationTiers = tiers.filter((t) => t.name.trim()).map((t) => ({
          id: t.id || t.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 16),
          name: t.name, perPersonSupplement: Number(t.perPersonSupplement) || 0, singleSupplement: Number(t.singleSupplement) || 0,
        }));
      }
      const r = await apiFetch(saveEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save.");
      const productId = j.product.id;

      // Publish any dates entered (merged create flow, validated above).
      // Every date carries its first booking — the server refuses one without.
      if (!agencyMode) {
        for (const r of wantDates) {
          const dr = await apiFetch("/admin/departures", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tourProductId: productId,
              ...(pkg ? { startDate: r.date } : { date: r.date }),
              firstTraveler: { name: r.name.trim(), email: r.email.trim(), phone: r.phone.trim(), seats: Number(r.seats) || 1 },
            }),
          });
          const dj = await dr.json();
          if (!dr.ok) throw new Error(dj.error || `Could not create the ${r.date} date.`);
        }
      }
      onSaved();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  const last = steps.length - 1;

  return (
    <div className="editor-page">
      <div className="editor-page-head">
        <button className="editor-back" onClick={onClose}><ArrowLeft size={16} />{agencyMode ? "Back to my listings" : "Back to Tours"}</button>
        <h1>{editing ? "Edit " : (agencyMode ? "List a new " : "New ")}{pkg ? "package" : "day tour"}</h1>
        <div className="wiz-steps">
          {steps.map((s, i) => (
            <button key={s} className={`wiz-step ${i === step ? "active" : ""} ${i < step ? "done" : ""}`} onClick={() => setStep(i)}>
              <span className="wiz-num">{i + 1}</span>{s}
            </button>
          ))}
        </div>
      </div>

      <div className="editor-page-body">
          {step === 0 && (
            <div className="form-grid">
              <Field label="Title" full><input value={f.title} onChange={set("title")} placeholder={pkg ? "Cairo & Luxor 4-day discovery" : "Giza Pyramids and Sphinx"} /></Field>
              {!pkg && <Field label="Destination"><select value={f.city} onChange={set("city")}>{cityOptions.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>}
              {pkg && <Field label="Cities (comma-separated)" full><input value={f.cities} onChange={set("cities")} placeholder="Cairo, Luxor" /></Field>}
              {pkg && <Field label="Nights"><input type="number" min="1" value={f.nights} onChange={set("nights")} /></Field>}
              <Field label="Duration label"><input value={f.duration} onChange={set("duration")} placeholder={pkg ? "4 days · 3 nights" : "4 hours"} /></Field>
              <Field label="Guide"><input value={f.guide} onChange={set("guide")} /></Field>
              <Field label="Vehicle"><input value={f.vehicle} onChange={set("vehicle")} /></Field>
              <Field label="Min seats (GoAhead)"><input type="number" min="4" max="12" value={f.minSeats} onChange={set("minSeats")} /></Field>
              <Field label="Max seats (cap)"><input type="number" min="1" max="12" value={f.maxSeats} onChange={set("maxSeats")} /></Field>
              <Field label={pkg ? "GoAhead price /person" : "GoAhead price"}><input type="number" min="1" value={f.publishedRate} onChange={set("publishedRate")} /></Field>
              <Field label="Break price (full group)"><input type="number" min="1" value={f.breakPrice} onChange={set("breakPrice")} placeholder="auto = 80%" /></Field>
              <PriceTierEditor
                on={useTiers}
                setOn={setUseTiers}
                rows={priceTiers}
                setRows={setPriceTiers}
                minSeats={Number(f.minSeats) || 4}
                maxSeats={Number(f.maxSeats) || 12}
                publishedRate={Number(f.publishedRate) || 0}
                breakPrice={Number(f.breakPrice) || 0}
              />
              <Field label="Deposit %"><input type="number" min="0" max="100" value={f.depositPercent} onChange={set("depositPercent")} /></Field>
              <Field label="Booking cutoff (hours before)"><input type="number" min="0" value={f.bookingCutoffHours} onChange={set("bookingCutoffHours")} /></Field>
              <Field label="Departs on (empty = any day)" full>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => {
                    const on = f.operatingDays.includes(i);
                    return (
                      <button type="button" key={d} aria-pressed={on}
                        onClick={() => setF({ ...f, operatingDays: on ? f.operatingDays.filter((x) => x !== i) : [...f.operatingDays, i].sort() })}
                        style={{ padding: "7px 12px", borderRadius: 999, border: on ? "1.5px solid #d9ab45" : "1px solid rgba(255,255,255,.25)", background: on ? "rgba(217,171,69,.2)" : "transparent", color: "inherit", font: "inherit", fontSize: ".82rem", fontWeight: on ? 700 : 400, cursor: "pointer" }}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field label="Short description (card)" full><textarea rows={2} value={f.description} onChange={set("description")} placeholder="One-line summary shown on the tour card." /></Field>
            </div>
          )}

          {step === 1 && (
            <div className="wiz-content">
              <Field label="Cover & gallery images" full hint="The first image is the cover. Hover a photo to reorder it or make it the cover.">
                <div className="img-grid">
                  {images.map((im, i) => (
                    <div className="img-thumb" key={i}>
                      <img src={im.url} alt={im.alt || ""} />
                      {i === 0 && <span className="img-cover">Cover</span>}
                      <button type="button" className="img-del" title="Remove" onClick={() => setImages((a) => a.filter((_, j) => j !== i))}><X size={13} /></button>
                      <div className="img-tools">
                        <button type="button" title="Move left" disabled={i === 0} onClick={() => moveImage(i, i - 1)}>‹</button>
                        {i > 0 && <button type="button" title="Make cover" onClick={() => moveImage(i, 0)}>Cover</button>}
                        <button type="button" title="Move right" disabled={i === images.length - 1} onClick={() => moveImage(i, i + 1)}>›</button>
                      </div>
                    </div>
                  ))}
                  <label className="img-add">
                    {uploading ? "Uploading…" : "+ Add"}
                    <input type="file" accept="image/*" multiple hidden onChange={(e) => handleUpload(e.target.files)} />
                  </label>
                </div>
              </Field>
              <Field label="Overview" full asDiv><RichText value={overviewHtml} onChange={setOverviewHtml} placeholder="Describe the experience — what makes it special, what travellers will see and do." /></Field>
              <RowList label="What's included" rows={included} setRows={setIncluded} placeholder="e.g. Licensed Egyptologist guide" />
              <RowList label="Not included" rows={notIncluded} setRows={setNotIncluded} placeholder="e.g. Entrance tickets" />
              <RowList label="What to bring" rows={whatToBring} setRows={setWhatToBring} placeholder="e.g. Sun hat, comfortable shoes" />
              <Field label="Meeting points" full>
                {!pkg && cityPresets.length > 0 && (
                  <div className="mp-presets">
                    <span className="mp-presets-hint">{f.city} meeting points (from Destinations) — tick the ones that apply:</span>
                    {cityPresets.map((preset, i) => {
                      const on = meetingPoints.some((m) => samePoint(m, preset));
                      return (
                        <label className={on ? "mp-preset on" : "mp-preset"} key={i}>
                          <input type="checkbox" checked={on} onChange={() => togglePreset(preset)} />
                          <span className="mp-preset-body">
                            <strong>{preset.point}</strong>
                            <span>{preset.note}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {!pkg && cityPresets.length === 0 && (
                  <span className="mp-presets-hint">No saved meeting points for {f.city}. Add them in the Destinations section, or add custom ones below.</span>
                )}
                <div className="mp-list">
                  {meetingPoints.map((m, i) => {
                    const isPreset = allPresetPoints.some((p) => samePoint(p, m));
                    if (isPreset) return null;
                    return (
                      <div className="mp-row" key={i}>
                        <input value={m.point} onChange={(e) => setMeetingPoints((l) => l.map((x, j) => j === i ? { ...x, point: e.target.value } : x))} placeholder="Meeting point / pickup location" />
                        <input value={m.note} onChange={(e) => setMeetingPoints((l) => l.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} placeholder="Be there by 8:00 AM / Departs 7:30 AM" />
                        <button type="button" className="icon-btn" onClick={() => setMeetingPoints((l) => l.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="btn-ghost sm" onClick={() => setMeetingPoints((l) => [...l, { point: "", note: "" }])}><Plus size={14} />Add custom meeting point</button>
              </Field>
              <Field label="Cancellation & policies" full asDiv><RichText value={policiesHtml} onChange={setPoliciesHtml} placeholder="Free cancellation up to 48h before, etc." /></Field>
            </div>
          )}

          {step === 2 && (
            <div className="wiz-content">
              {pkg ? (
                <>
                  <div className="modal-subhead"><h3>Day-by-day itinerary</h3><button type="button" className="btn-ghost sm" onClick={() => setItinerary((it) => [...it, { day: it.length + 1, city: "", title: "", description: "", meals: "Breakfast" }])}><Plus size={14} />Add day</button></div>
                  {itinerary.map((d, i) => (
                    <div className="itin-card" key={i}>
                      <div className="itin-card-head"><span className="itin-day">Day {i + 1}</span><button type="button" className="icon-btn" onClick={() => setItinerary((it) => it.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>
                      <div className="itin-card-row">
                        <input placeholder="City" value={d.city} onChange={(e) => setItinerary((it) => it.map((x, j) => j === i ? { ...x, city: e.target.value } : x))} />
                        <input placeholder="Title (e.g. Pyramids & Museum)" value={d.title} onChange={(e) => setItinerary((it) => it.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
                        <input placeholder="Meals" value={d.meals} onChange={(e) => setItinerary((it) => it.map((x, j) => j === i ? { ...x, meals: e.target.value } : x))} />
                      </div>
                      <RichText value={d.description} onChange={(html) => setItinerary((it) => it.map((x, j) => j === i ? { ...x, description: html } : x))} placeholder="What happens on this day…" />
                    </div>
                  ))}
                  <div className="modal-subhead"><h3>Hotel tiers</h3><button type="button" className="btn-ghost sm" onClick={() => setTiers((t) => [...t, { id: "", name: "", perPersonSupplement: 0, singleSupplement: 0 }])}><Plus size={14} />Add tier</button></div>
                  {tiers.map((t, i) => (
                    <div className="itin-row" key={i}>
                      <input placeholder="Tier name (e.g. Superior 4★)" value={t.name} onChange={(e) => setTiers((ts) => ts.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                      <input type="number" placeholder="+/person" value={t.perPersonSupplement} onChange={(e) => setTiers((ts) => ts.map((x, j) => j === i ? { ...x, perPersonSupplement: e.target.value } : x))} />
                      <input type="number" placeholder="single supp." value={t.singleSupplement} onChange={(e) => setTiers((ts) => ts.map((x, j) => j === i ? { ...x, singleSupplement: e.target.value } : x))} />
                      <button type="button" className="icon-btn" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </>
              ) : (
                <p className="dash-empty">Day tours don't need a multi-day itinerary. Use the Overview on the previous step to describe the day. Continue to add dates.</p>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="wiz-content">
              {editing && (
                <>
                  <div className="modal-subhead">
                    <h3>Scheduled dates ({scheduled.length})</h3>
                  </div>
                  <p className="field-hint">Every date already published for this tour, with live bookings. Confirm or cancel them from the Departures section.</p>
                  {scheduled.length > 0 ? (
                    <div className="table-wrap" style={{ marginBottom: 26 }}>
                      <table className="dash-table">
                        <thead><tr><th>Date</th><th>Status</th><th>Booked</th></tr></thead>
                        <tbody>
                          {scheduled.map((d) => {
                            const seats = seatsOf(d);
                            const min = Number(d.minSeats || f.minSeats) || 4;
                            const past = new Date(`${d.startDate || d.date}T23:59:59`) < new Date();
                            const tag = d.status === "cancelled" ? <span className="tag tag-off">Cancelled</span>
                              : past ? <span className="tag tag-off">Departed</span>
                              : d.status === "supplier_confirmed" ? <span className="tag tag-on">Confirmed</span>
                              : d.status === "pending_review" ? <span className="tag tag-off">Pending review</span>
                              : seats >= min ? <span className="tag tag-on">GoAhead</span>
                              : <span className="tag">Forming</span>;
                            return (
                              <tr key={d.id} className={d.status === "cancelled" || past ? "row-archived" : ""}>
                                <td><strong>{fmtDate(d.startDate || d.date)}</strong>{d.endDate ? ` – ${fmtDate(d.endDate)}` : ""}</td>
                                <td>{tag}</td>
                                <td>{seats} of {min} to GoAhead · max {d.maxSeats || f.maxSeats}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="dash-empty" style={{ marginBottom: 26 }}>No dates scheduled yet — create the first one below.</p>
                  )}
                </>
              )}
              <div className="modal-subhead">
                <h3>Create a date</h3>
                <button type="button" className="btn-ghost sm" onClick={() => setDates((d) => [...d, newDateRow()])}><Plus size={14} />Add date</button>
              </div>
              <p className="field-hint">A date is created together with its <strong>first booking</strong> — record the traveller it belongs to (bookings that arrive by phone or WhatsApp; email or phone, at least one). Travellers on the website create dates themselves from the itinerary page, so leave this empty unless someone has actually booked. Each date holds up to {f.maxSeats} travellers.</p>
              {dates.map((r, i) => (
                <div className="date-row" key={i}>
                  <input type="date" value={r.date} onChange={setDateRow(i, "date")} />
                  <input type="text" placeholder="Traveller name" value={r.name} onChange={setDateRow(i, "name")} />
                  <input type="email" placeholder="Email" value={r.email} onChange={setDateRow(i, "email")} />
                  <input type="tel" placeholder="Phone / WhatsApp" value={r.phone} onChange={setDateRow(i, "phone")} />
                  <input type="number" min={1} max={f.maxSeats} title="Seats" value={r.seats} onChange={setDateRow(i, "seats")} />
                  <button type="button" className="icon-btn" onClick={() => setDates((a) => a.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}

          {err && <div className="auth-error" role="alert">{err}</div>}
        </div>

        <div className="editor-page-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <div className="wiz-nav">
            {step > 0 && <button type="button" className="btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
            {step < last && <button type="button" className="btn-primary" onClick={() => setStep(step + 1)}>Next</button>}
            {step === last && <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : agencyMode ? (editing ? "Save & resubmit" : "Submit for review") : editing ? "Save changes" : (pkg ? "Create package" : "Create tour")}</button>}
          </div>
        </div>
    </div>
  );
}

// Per-headcount pricing. Off by default: the GoAhead/break anchors above draw a
// straight line between them, which suits most tours. This is for the ones
// whose costs step — a seven-seater up to six travellers, a minibus beyond —
// where a slope either overcharges the small group or undercharges the large.
//
// Every group size from the minimum to the cap gets a row, prefilled from the
// straight line, so switching on changes nothing until a number is edited and
// the operator can see exactly what each group pays.
function PriceTierEditor({ on, setOn, rows, setRows, minSeats, maxSeats, publishedRate, breakPrice }) {
  const sizes = [];
  for (let s = minSeats; s <= maxSeats; s += 1) sizes.push(s);

  // The interpolation, mirrored, purely to prefill and to label the default.
  const straightLine = (seats) => {
    const start = publishedRate || 80;
    const brk = Math.min(start, breakPrice || Math.round(start * 0.8));
    const steps = Math.max(1, maxSeats - minSeats);
    return Math.round(start - (start - brk) * Math.min(1, Math.max(0, seats - minSeats) / steps));
  };

  function enable() {
    setRows(sizes.map((s) => {
      const existing = rows.find((r) => Number(r.seats) === s);
      return { seats: s, price: existing ? existing.price : straightLine(s) };
    }));
    setOn(true);
  }

  const priceAt = (s) => {
    const row = rows.find((r) => Number(r.seats) === s);
    return row ? row.price : "";
  };
  const setPriceAt = (s, value) =>
    setRows((list) => {
      const next = list.filter((r) => Number(r.seats) !== s);
      next.push({ seats: s, price: value });
      return next.sort((a, b) => a.seats - b.seats);
    });

  // Mirrors the server's rule so the operator sees the problem before saving.
  const numeric = rows.filter((r) => String(r.price).trim() !== "").sort((a, b) => a.seats - b.seats);
  const rising = numeric.find((r, i) => i > 0 && Number(r.price) > Number(numeric[i - 1].price));

  return (
    <Field label="Price per group size" full asDiv>
      {!on ? (
        <div className="tier-off">
          <p>
            Prices slide evenly from <b>${publishedRate || 0}</b> at {minSeats} travellers to{" "}
            <b>${breakPrice || Math.round((publishedRate || 0) * 0.8)}</b> at {maxSeats}.
          </p>
          <button type="button" className="btn-ghost sm" onClick={enable}>Set a price for each group size</button>
        </div>
      ) : (
        <div className="tier-grid-wrap">
          <div className="tier-grid">
            {sizes.map((s) => (
              <label className="tier-cell" key={s}>
                <span>{s} {s === 1 ? "traveller" : "travellers"}{s === minSeats ? " · GoAhead" : ""}</span>
                <div className="tier-input">
                  <i>$</i>
                  <input
                    type="number" min="1" inputMode="numeric"
                    value={priceAt(s)}
                    onChange={(e) => setPriceAt(s, e.target.value)}
                    aria-label={`Price per person for ${s} travellers`}
                  />
                </div>
              </label>
            ))}
          </div>
          {rising && (
            <p className="tier-warn" role="alert">
              The price goes up at {rising.seats} travellers. It has to fall, or stay level, as the group grows — that's the promise on every page of the site.
            </p>
          )}
          <div className="tier-actions">
            <span className="tier-note">Per person, USD. A traveller pays the price for the group size their booking reaches.</span>
            <button type="button" className="btn-ghost sm" onClick={() => { setOn(false); setRows([]); }}>
              Use the sliding price instead
            </button>
          </div>
        </div>
      )}
    </Field>
  );
}

function RowList({ label, rows, setRows, placeholder }) {
  return (
    <div className="rowlist">
      <div className="rowlist-head"><span>{label}</span><button type="button" className="btn-ghost sm" onClick={() => setRows((r) => [...r, ""])}><Plus size={13} />Add</button></div>
      {rows.map((v, i) => (
        <div className="rowlist-row" key={i}>
          <input value={v} placeholder={placeholder} onChange={(e) => setRows((r) => r.map((x, j) => j === i ? e.target.value : x))} />
          <button type="button" className="icon-btn" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
        </div>
      ))}
    </div>
  );
}

// `asDiv` renders a <div> instead of a <label>. Required for rich-text editors:
// a <label> forwards clicks to its first labelable descendant (the Bold toolbar
// button), which steals focus from the contenteditable and blocks typing.
function Field({ label, children, full, asDiv, hint }) {
  const Tag = asDiv ? "div" : "label";
  return (
    <Tag className={`field ${full ? "field-full" : ""}`}>
      <span>{label}</span>
      {hint && <em className="field-hint">{hint}</em>}
      {children}
    </Tag>
  );
}

/* ---------------- Listing requests (approval) ---------------- */
const LISTING_TABS = [
  { id: "pending", label: "Awaiting review" },
  { id: "rejected", label: "Rejected" },
  { id: "approved", label: "Approved" },
];
// Traveler-requested departures awaiting review (addendum Phase A).
// Approve -> departure opens on the public board; decline -> cancelled + email.
function DateRequestsSection({ data, reload, flash }) {
  const [declining, setDeclining] = useState(null); // departure being declined
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const pending = (data.departures || [])
    .filter((d) => d.status === "pending_review")
    .sort((a, b) => new Date(a.startDate || a.date) - new Date(b.startDate || b.date));
  const seedOf = (d) => (d.pledges || []).find((p) => p.source === "public_request") || (d.pledges || [])[0];

  async function act(dep, action, body) {
    setBusy(dep.id); setErr("");
    try {
      const r = await apiFetch(`/admin/departure-requests/${dep.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `Could not ${action} this request.`);
      flash(action === "approve"
        ? `"${dep.route}" on ${fmtDate(dep.startDate || dep.date)} is now open — traveller emailed.`
        : `Request declined — traveller emailed.`);
      setDeclining(null); setReason(""); reload();
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }

  return (
    <>
      <PageHead title="Date requests" sub="Departures started by travellers on the public site. Nothing shows on the board until you approve it." />
      {err && !declining && <div className="auth-error" role="alert">{err}</div>}
      {!pending.length && <div className="dash-empty">No traveller-requested dates awaiting review right now.</div>}

      <div className="listing-grid">
        {pending.map((d) => {
          const seed = seedOf(d) || {};
          return (
            <article className="listing-card" key={d.id}>
              <div className="listing-body">
                <div className="listing-top">
                  <h3>{d.route}</h3>
                  <span className="tag tag-ready"><Clock3 size={13} /> Awaiting review</span>
                </div>
                <p className="listing-agency">
                  <strong>{fmtDate(d.startDate || d.date)}</strong>{d.time ? ` · ${d.time}` : ""} · {d.city}
                </p>
                <div className="listing-facts">
                  <span><Users size={13} />{seed.seats || 1} seat{(seed.seats || 1) > 1 ? "s" : ""} pledged · min {d.minSeats} · max {d.maxSeats}</span>
                  <span><ClipboardList size={13} />{seed.customers || "Traveller"}</span>
                </div>
                <p className="listing-desc">
                  {seed.customerEmail || "no email"}{seed.customerPhone ? ` · ${seed.customerPhone}` : ""}
                  {d.notes ? ` — ${d.notes}` : ""}
                </p>
                <div className="listing-actions">
                  <button className="btn-primary" disabled={busy === d.id} onClick={() => act(d, "approve")}>
                    <Check size={14} /> Approve &amp; open
                  </button>
                  <button className="btn-ghost danger" disabled={busy === d.id} onClick={() => { setDeclining(d); setReason(""); setErr(""); }}>
                    <X size={14} /> Decline
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {declining && (
        <div className="modal-overlay" onClick={() => setDeclining(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Decline "{declining.route}" on {fmtDate(declining.startDate || declining.date)}?</h3>
            </div>
            <div className="modal-body">
              <p>The traveller is emailed that the date couldn't be opened. A short reason helps them pick another date.</p>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional, sent to the traveller)" rows={3} />
              {err && <div className="auth-error" role="alert">{err}</div>}
              <div className="listing-actions">
                <button className="btn-ghost" onClick={() => setDeclining(null)}>Keep request</button>
                <button className="btn-primary danger" disabled={busy === declining.id} onClick={() => act(declining, "decline", { reason: reason.trim() })}>
                  Decline request
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function statusTag(status) {
  if (status === "approved") return <span className="tag tag-on">Approved</span>;
  if (status === "rejected") return <span className="tag tag-off">Rejected</span>;
  return <span className="tag tag-warn">Awaiting review</span>;
}
function ListingRequestsSection({ data, reload, flash }) {
  const [tab, setTab] = useState("pending");
  const [rejecting, setRejecting] = useState(null); // product being rejected
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState(null); // listing being viewed in full

  // Only agency-submitted listings enter this queue (agency_id present).
  const submitted = (data.tourProducts || []).filter((p) => p.agencyId);
  const pending = submitted.filter((p) => p.status === "pending");
  const shown = submitted
    .filter((p) => p.status === tab)
    .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
  const agencyName = (id) => data.agencies?.find((a) => String(a.id) === String(id))?.name || "An agency";

  async function approve(p) {
    setBusy(p.id); setErr("");
    try {
      const r = await apiFetch(`/admin/tour-products/${p.id}/approve`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not approve.");
      flash(`"${p.title}" approved${j.notified ? " — agency emailed" : ""}.`);
      reload();
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }
  async function reject() {
    if (!reason.trim()) { setErr("Please write a reason."); return; }
    setBusy(rejecting.id); setErr("");
    try {
      const r = await apiFetch(`/admin/tour-products/${rejecting.id}/reject`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not reject.");
      flash(`"${rejecting.title}" rejected${j.notified ? " — agency emailed the reason" : ""}.`);
      setRejecting(null); setReason(""); reload();
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }

  return (
    <>
      <PageHead title="Listing requests" sub="Tours submitted by agencies. Nothing goes live until you approve it." />
      <div className="seg-tabs">
        {LISTING_TABS.map((t) => (
          <button key={t.id} className={`seg-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}{t.id === "pending" && pending.length ? <span className="seg-count">{pending.length}</span> : null}
          </button>
        ))}
      </div>

      {err && !rejecting && <div className="auth-error" role="alert">{err}</div>}

      {!shown.length && <div className="dash-empty">No {tab === "pending" ? "listings awaiting review" : tab + " listings"} right now.</div>}

      <div className="listing-grid">
        {shown.map((p) => {
          const img = p.images?.[0]?.url;
          return (
            <article className="listing-card" key={p.id}>
              <div className="listing-media">
                {img ? <img src={img} alt={p.title} /> : <div className="listing-noimg"><Package size={22} /></div>}
                <span className="listing-type">{p.type === "package" ? "Package" : "Day tour"}</span>
              </div>
              <div className="listing-body">
                <div className="listing-top">
                  <h3>{p.title || "Untitled listing"}</h3>
                  {statusTag(p.status)}
                </div>
                <p className="listing-agency">by <strong>{agencyName(p.agencyId)}</strong>{p.submittedAt ? ` · submitted ${fmtDate(p.submittedAt)}` : ""}</p>
                <p className="listing-desc">{p.description || "No description provided."}</p>
                <div className="listing-facts">
                  <span><MapPin size={13} />{p.city || "—"}</span>
                  <span><CalendarDays size={13} />{p.duration || "—"}</span>
                  <span><CircleDollarSign size={13} />{money(p.publishedRate)}/person</span>
                  <span><Users size={13} />min {p.minSeats} · max {p.maxSeats}</span>
                  <span><Package size={13} />{(p.images?.length || 0)} photos</span>
                </div>
                {p.included?.length ? <p className="listing-inc"><strong>Includes:</strong> {p.included.slice(0, 4).join(" · ")}{p.included.length > 4 ? "…" : ""}</p> : null}
                {p.status === "rejected" && p.rejectionReason ? (
                  <div className="listing-reject"><strong>Rejection reason</strong><br />{p.rejectionReason}</div>
                ) : null}
                <div className="listing-actions">
                  <button className="btn-ghost sm" onClick={() => setPreview(p)}><Eye size={15} />View details</button>
                  {p.status !== "approved" && (
                    <>
                      <button className="btn-primary sm" disabled={busy === p.id} onClick={() => approve(p)}><Check size={15} />{busy === p.id ? "…" : "Approve & publish"}</button>
                      <button className="btn-ghost sm danger" disabled={busy === p.id} onClick={() => { setRejecting(p); setReason(""); setErr(""); }}><X size={15} />Reject</button>
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {preview && (
        <ListingPreviewModal
          p={preview}
          agencyName={agencyName(preview.agencyId)}
          busy={busy === preview.id}
          onApprove={() => { const t = preview; setPreview(null); approve(t); }}
          onReject={() => { setRejecting(preview); setReason(""); setErr(""); setPreview(null); }}
          onClose={() => setPreview(null)}
        />
      )}

      {rejecting && (
        <div className="modal-overlay" onClick={() => setRejecting(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>Reject "{rejecting.title}"</h2><button className="icon-btn" onClick={() => setRejecting(null)}><X size={18} /></button></div>
            <div className="modal-body">
              <p className="field-hint">Write why this listing can't go live. The agency receives this reason by email and can edit &amp; resubmit.</p>
              <textarea className="reason-box" rows={5} autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. A very similar Giza day tour is already listed — please differentiate the itinerary or merge with the existing one." />
              {err && <div className="auth-error" role="alert">{err}</div>}
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" onClick={() => setRejecting(null)}>Cancel</button>
              <button className="btn-primary danger" disabled={busy === rejecting.id} onClick={reject}>{busy === rejecting.id ? "Sending…" : "Reject & notify agency"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* Full read-only view of a submitted listing so admins can review every field
   (overview, itinerary, meeting points, policies, gallery…) before deciding. */
function ListingPreviewModal({ p, agencyName, busy, onApprove, onReject, onClose }) {
  const [gi, setGi] = useState(0);
  const richHas = (s) => s && s.replace(/<[^>]*>/g, "").trim().length > 0;
  const pkg = p.type === "package";
  const imgs = (p.images || []).filter((i) => i?.url);
  const hero = imgs[Math.min(gi, Math.max(0, imgs.length - 1))]?.url;
  const meetPts = (p.meetingPoints || []).filter((m) => m && m.point);
  const Row = ({ label, children }) => (
    <div style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--d-line)", fontSize: 14 }}>
      <span style={{ color: "var(--d-muted, #667)", minWidth: 150 }}>{label}</span>
      <strong style={{ color: "var(--d-ink, #111)" }}>{children}</strong>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 880, width: "94vw", maxHeight: "92vh", display: "flex", flexDirection: "column" }}>
        <div className="modal-head">
          <h2>{p.title || "Untitled listing"} {statusTag(p.status)}</h2>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="modal-body" style={{ overflowY: "auto" }}>
          <p className="field-hint" style={{ marginTop: 0 }}>
            {pkg ? "Multi-day package" : "Day tour"} · by <strong>{agencyName}</strong>{p.submittedAt ? ` · submitted ${fmtDate(p.submittedAt)}` : ""}
          </p>

          {hero && (
            <>
              <img src={hero} alt={p.title} style={{ width: "100%", height: 300, objectFit: "cover", borderRadius: 12, marginTop: 8 }} />
              {imgs.length > 1 && (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  {imgs.map((im, i) => (
                    <button key={i} onClick={() => setGi(i)} style={{ width: 64, height: 48, borderRadius: 8, overflow: "hidden", border: i === gi ? "2px solid var(--d-accent, #c58b2e)" : "2px solid transparent", padding: 0, cursor: "pointer" }}>
                      <img src={im.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          <div style={{ marginTop: 18 }}>
            <Row label="Location">{pkg ? (p.cities || [p.city]).filter(Boolean).join(" → ") || "—" : p.city || "—"}</Row>
            {p.duration ? <Row label="Duration">{p.duration}</Row> : null}
            {pkg && p.nights ? <Row label="Nights">{p.nights}</Row> : null}
            <Row label="Guide">{p.guide || "—"}</Row>
            <Row label="Vehicle">{p.vehicle || "—"}</Row>
            <Row label="GoAhead price">{money(p.publishedRate)} / person</Row>
            {p.breakPrice ? <Row label="Full-group price">{money(p.breakPrice)} / person</Row> : null}
            <Row label="Group size">min {p.minSeats} · max {p.maxSeats}</Row>
            {p.depositPercent != null ? <Row label="Deposit">{p.depositPercent}%</Row> : null}
            {p.bookingCutoffHours != null ? <Row label="Booking cutoff">{p.bookingCutoffHours}h before</Row> : null}
          </div>

          {p.description ? (
            <section style={{ marginTop: 20 }}><h3 style={{ fontSize: 15, marginBottom: 6 }}>Short description</h3><p style={{ fontSize: 14, color: "var(--d-muted,#556)" }}>{p.description}</p></section>
          ) : null}

          {richHas(p.overviewHtml) ? (
            <section style={{ marginTop: 20 }}><h3 style={{ fontSize: 15, marginBottom: 6 }}>Overview</h3><div className="rich" dangerouslySetInnerHTML={{ __html: p.overviewHtml }} /></section>
          ) : null}

          {(p.included?.length || p.notIncluded?.length) ? (
            <section style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div>
                <h3 style={{ fontSize: 15, marginBottom: 6 }}>What's included</h3>
                {p.included?.length ? p.included.map((x, i) => <p key={i} style={{ fontSize: 14, display: "flex", gap: 6 }}><Check size={15} />{x}</p>) : <p className="field-hint">—</p>}
              </div>
              <div>
                <h3 style={{ fontSize: 15, marginBottom: 6 }}>Not included</h3>
                {p.notIncluded?.length ? p.notIncluded.map((x, i) => <p key={i} style={{ fontSize: 14, display: "flex", gap: 6 }}><X size={15} />{x}</p>) : <p className="field-hint">—</p>}
              </div>
            </section>
          ) : null}

          {p.whatToBring?.length ? (
            <section style={{ marginTop: 20 }}><h3 style={{ fontSize: 15, marginBottom: 6 }}>What to bring</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{p.whatToBring.map((b, i) => <span key={i} className="tag">{b}</span>)}</div>
            </section>
          ) : null}

          {meetPts.length ? (
            <section style={{ marginTop: 20 }}><h3 style={{ fontSize: 15, marginBottom: 6 }}><MapPin size={14} /> Meeting &amp; pickup</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                {meetPts.map((m, i) => <li key={i}><strong>{m.point}</strong>{m.note ? ` — ${m.note}` : ""}</li>)}
              </ul>
            </section>
          ) : (p.meetingPoint ? (
            <section style={{ marginTop: 20 }}><h3 style={{ fontSize: 15, marginBottom: 6 }}><MapPin size={14} /> Meeting &amp; pickup</h3>
              <p style={{ fontSize: 14 }}>{p.meetingPoint}{p.pickupNote ? ` — ${p.pickupNote}` : ""}</p>
            </section>
          ) : null)}

          {pkg && (p.itinerary || []).length ? (
            <section style={{ marginTop: 20 }}><h3 style={{ fontSize: 15, marginBottom: 6 }}>Day-by-day itinerary</h3>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {p.itinerary.map((d, i) => (
                  <li key={i} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--d-accent,#c58b2e)" }}>Day {d.day || i + 1}{d.city ? ` · ${d.city}` : ""}</div>
                    <strong style={{ fontSize: 14 }}>{d.title}</strong>
                    {richHas(d.description) ? <div className="rich" dangerouslySetInnerHTML={{ __html: d.description }} /> : d.description ? <p style={{ fontSize: 14 }}>{d.description}</p> : null}
                    {d.meals ? <small style={{ color: "var(--d-muted,#667)" }}>Meals: {d.meals}</small> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {pkg && (p.accommodationTiers || []).length ? (
            <section style={{ marginTop: 20 }}><h3 style={{ fontSize: 15, marginBottom: 6 }}><Hotel size={14} /> Hotel &amp; cruise tiers</h3>
              {p.accommodationTiers.map((t, i) => (
                <div key={i} style={{ fontSize: 14, padding: "4px 0" }}><strong>{t.name}</strong>{t.perPersonSupplement ? ` · +${money(t.perPersonSupplement)}/pp` : ""}{t.singleSupplement ? ` · single +${money(t.singleSupplement)}` : ""}</div>
              ))}
            </section>
          ) : null}

          {richHas(p.policiesHtml) ? (
            <section style={{ marginTop: 20 }}><h3 style={{ fontSize: 15, marginBottom: 6 }}><ShieldCheck size={14} /> Cancellation &amp; policies</h3><div className="rich" dangerouslySetInnerHTML={{ __html: p.policiesHtml }} /></section>
          ) : null}

          {p.status === "rejected" && p.rejectionReason ? (
            <div className="listing-reject" style={{ marginTop: 20 }}><strong>Rejection reason</strong><br />{p.rejectionReason}</div>
          ) : null}
        </div>

        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          {p.status !== "approved" && (
            <>
              <button className="btn-ghost danger" disabled={busy} onClick={onReject}><X size={15} /> Reject</button>
              <button className="btn-primary" disabled={busy} onClick={onApprove}><Check size={15} /> {busy ? "…" : "Approve & publish"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Departures ---------------- */
function DeparturesSection({ data, reload, flash }) {
  const [filter, setFilter] = useState("all");
  const [pub, setPub] = useState(null); // {type}
  const deps = data.departures || [];
  const shown = deps.filter((d) => {
    if (filter === "all") return true;
    if (filter === "ready") return d.status !== "supplier_confirmed" && d.status !== "cancelled" && seatsOf(d) >= (d.minSeats || 4);
    if (filter === "confirmed") return d.status === "supplier_confirmed";
    if (filter === "open") return d.status === "open" || (d.status === "minimum_reached" && seatsOf(d) < (d.minSeats || 4));
    if (filter === "cancelled") return d.status === "cancelled";
    return true;
  });

  async function confirm(d) {
    const r = await apiFetch(`/admin/departures/${d.id}/confirm`, { method: "POST" });
    const j = await r.json();
    if (r.ok) { flash("Departure confirmed — travellers notified."); reload(); } else flash(j.error || "Could not confirm.");
  }
  async function cancel(d) {
    if (!window.confirm(`Cancel "${d.route}" on ${fmtDate(d.startDate || d.date)}? Travellers with an email will be notified.`)) return;
    const r = await apiFetch(`/admin/departures/${d.id}/cancel`, { method: "POST" });
    if (r.ok) { flash("Departure cancelled."); reload(); }
  }

  return (
    <>
      <PageHead title="Departures" sub="Publish dates, confirm GoAhead, and manage what's running."
        action={
          <div className="head-actions">
            <button className="btn-ghost" onClick={() => setPub({ type: "day_tour" })}><Plus size={16} />Create tour date</button>
            <button className="btn-primary" onClick={() => setPub({ type: "package" })}><Plus size={16} />Create package date</button>
          </div>
        } />

      <div className="seg">
        {["all", "open", "ready", "confirmed", "cancelled"].map((k) => (
          <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>
            {k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table className="dash-table">
          <thead><tr><th>Route</th><th>When</th><th>Seats</th><th>Live $</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {shown.map((d) => {
              const seats = seatsOf(d), min = d.minSeats || 4, ready = seats >= min;
              return (
                <tr key={d.id} className={d.status === "cancelled" ? "row-archived" : ""}>
                  <td><strong>{isPkg(d) && <span className="tag tag-pkg">Pkg</span>} {d.route}</strong><div className="sub">{(d.cities || [d.city]).join(" → ")}</div></td>
                  <td>{fmtDate(d.startDate || d.date)}{d.endDate ? ` – ${fmtDate(d.endDate)}` : ""}</td>
                  <td><span className={ready ? "seats ok" : "seats"}>{seats}/{min}</span><span className="sub">max {d.maxSeats}</span></td>
                  <td>{money(d.livePrice)}</td>
                  <td><StatusTag d={d} /></td>
                  <td className="row-actions">
                    {d.status !== "supplier_confirmed" && d.status !== "cancelled" && (
                      <button className="btn-mini" disabled={!ready} onClick={() => confirm(d)}><Check size={14} />Confirm</button>
                    )}
                    {d.status !== "cancelled" && <button className="icon-btn danger" title="Cancel departure" onClick={() => cancel(d)}><X size={15} /></button>}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={6}><Empty label="No departures match this filter." /></td></tr>}
          </tbody>
        </table>
      </div>

      {pub && <PublishModal type={pub.type} data={data} onClose={() => setPub(null)} onDone={(code) => { setPub(null); flash(code ? `Date created with its first booking — code ${code}.` : "Date created."); reload(); }} />}
    </>
  );
}

function StatusTag({ d }) {
  const seats = seatsOf(d), min = d.minSeats || 4;
  if (d.status === "cancelled") return <span className="tag tag-off">Cancelled</span>;
  if (d.status === "supplier_confirmed") return <span className="tag tag-on">GoAhead</span>;
  if (seats >= min) return <span className="tag tag-ready">Ready</span>;
  return <span className="tag">Forming</span>;
}

function PublishModal({ type, data, onClose, onDone }) {
  const pkg = type === "package";
  const products = (data.tourProducts || []).filter((p) => (pkg ? isPkg(p) : !isPkg(p)) && p.active !== false);
  const [productId, setProductId] = useState(products[0]?.id || "");
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [seats, setSeats] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function go(e) {
    e.preventDefault();
    if (!productId) return setErr("Pick a product.");
    if (!date) return setErr("Pick a date.");
    if (!name.trim()) return setErr("A date is created by its first booking — record the traveller's name.");
    if (!email.trim() && !phone.trim()) return setErr("Record how to reach the traveller — an email or phone number.");
    setBusy(true); setErr("");
    try {
      const body = {
        tourProductId: productId,
        ...(pkg ? { startDate: date } : { date }),
        firstTraveler: { name: name.trim(), email: email.trim(), phone: phone.trim(), seats: Number(seats) || 1 },
      };
      const r = await apiFetch("/admin/departures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not create the date.");
      onDone(j.bookingCode);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{pkg ? "Create a package date" : "Create a tour date"}</h2><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <form onSubmit={go}>
          <div className="modal-body">
            <p className="field-hint">A date is created together with its first booking — use this for bookings that arrive by phone or WhatsApp. Travellers on the website start dates themselves from the itinerary page.</p>
            <Field label={pkg ? "Package" : "Tour"} full>
              <select value={productId} onChange={(e) => setProductId(e.target.value)}>
                {products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </Field>
            <Field label={pkg ? "Start date" : "Date"} full><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="First traveller" full><input type="text" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Email"><input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Phone / WhatsApp"><input type="tel" placeholder="+20 …" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            <Field label="Seats"><input type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} /></Field>
            {products.length === 0 && <p className="dash-empty">No active {pkg ? "packages" : "tours"}. Create one first.</p>}
            {err && <div className="auth-error">{err}</div>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !products.length}>{busy ? "Creating…" : "Create date & booking"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---------------- Bookings ---------------- */
const BOOKING_STATUSES = ["pending", "confirmed", "paid", "cancelled"];
function bookingStatusTag(s) {
  if (s === "paid") return "tag-on";
  if (s === "cancelled") return "tag-off";
  if (s === "pending") return "tag-ready";
  return "tag";
}

const BOOKING_FILTERS = [
  { id: "all", label: "All" },
  { id: "pending", label: "Requests" },
  { id: "confirmed", label: "Confirmed" },
  { id: "paid", label: "Paid" },
  { id: "cancelled", label: "Cancelled" },
];
function depFillStatus(d) {
  const seats = seatsOf(d), min = Math.max(1, d.minSeats || 4);
  if (d.status === "cancelled") return { key: "cancelled", label: "Cancelled", tone: "off", seats, min };
  if (d.status === "supplier_confirmed") return { key: "confirmed", label: "Confirmed · running", tone: "on", seats, min };
  if (seats >= min) return { key: "ready", label: "Ready to confirm", tone: "ready", seats, min };
  return { key: "forming", label: `${min - seats} more to GoAhead`, tone: "warn", seats, min };
}
function BookingsSection({ data, stats }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState("list");   // list | tours
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(null); // selected booking

  const [total, setTotal] = useState(0);

  async function load() {
    // Ask for the server's maximum. The list is still a window, so `total` below
    // says how many exist and the UI admits when it isn't showing all of them.
    const j = await apiFetch("/admin/bookings?limit=1000").then((r) => r.json()).catch(() => ({ bookings: [] }));
    setRows(j.bookings || []);
    setTotal(Number(j.total) || (j.bookings || []).length);
    return j.bookings || [];
  }
  useEffect(() => { load(); }, []);

  const all = rows || [];
  const counts = all.reduce((m, b) => { m[b.status] = (m[b.status] || 0) + 1; return m; }, {});
  // Headline money/seat figures come from /admin/stats, which aggregates EVERY
  // pledge server-side. Deriving them from `all` made them silently mean "the
  // most recent page" once the platform passed the fetch limit. Fall back to the
  // loaded rows only if stats hasn't arrived.
  const loadedTotals = all.reduce((m, b) => {
    if (b.status !== "cancelled") { m.seats += Number(b.seats || 0); m.revenue += Number(b.bookingTotal || 0); m.deposits += Number(b.depositDue || 0); }
    return m;
  }, { seats: 0, revenue: 0, deposits: 0 });
  const st = stats?.totals;
  const totals = st
    ? { seats: st.seatsPooled, revenue: st.revenue, deposits: st.depositsDue }
    : loadedTotals;
  const bookingCount = st ? st.bookings : all.filter((b) => b.status !== "cancelled").length;
  const cancelledTotal = st ? st.cancelledBookings : (counts.cancelled || 0);
  const truncated = total > all.length;

  const shown = all.filter((b) => {
    if (filter !== "all" && b.status !== filter) return false;
    if (!q) return true;
    const t = `${b.route} ${b.customers} ${b.customerEmail} ${b.customerPhone} ${b.agency} ${b.bookingCode}`.toLowerCase();
    return t.includes(q.toLowerCase());
  });

  // Per-departure roll-up: how each date is filling + its booking value.
  const revByDep = all.reduce((m, b) => {
    if (b.status === "cancelled") return m;
    const e = m[b.departureId] || (m[b.departureId] = { seats: 0, revenue: 0, count: 0 });
    e.seats += Number(b.seats || 0); e.revenue += Number(b.bookingTotal || 0); e.count += 1;
    return m;
  }, {});
  const tourRows = (data?.departures || [])
    .filter((d) => d.status !== "cancelled" && (revByDep[d.id] || seatsOf(d) > 0))
    .map((d) => ({ d, fill: depFillStatus(d), agg: revByDep[d.id] || { seats: seatsOf(d), revenue: 0, count: 0 } }))
    .filter(({ d }) => { if (!q) return true; return `${d.route} ${d.city}`.toLowerCase().includes(q.toLowerCase()); })
    .sort((a, b) => new Date(a.d.startDate || a.d.date) - new Date(b.d.startDate || b.d.date));

  async function setStatus(id, status) {
    const r = await apiFetch(`/admin/bookings/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    if (r.ok) { const list = await load(); setOpen((o) => (o ? list.find((b) => b.id === o.id) || null : null)); }
  }

  function exportCsv() {
    const cols = ["bookingCode", "customers", "customerEmail", "customerPhone", "route", "date", "seats", "bookingTotal", "depositDue", "balanceDue", "status", "agency", "source", "createdAt"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...shown.map((b) => cols.map((c) => esc(b[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "sawa-bookings.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHead title="Bookings" sub="Every seat booked across agencies and direct travellers."
        action={
          <div className="head-actions">
            <div className="search-box"><Search size={16} /><input placeholder="Search name, email, route…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <button className="btn-ghost" onClick={exportCsv} disabled={!shown.length}>Export CSV</button>
          </div>
        } />

      {rows === null && <DashSkeleton />}
      {rows && (
        <>
          <div className="bk-summary">
            <div className="bk-kpi"><span>Bookings</span><strong>{bookingCount}</strong><i>{counts.pending || 0} awaiting confirmation</i></div>
            <div className="bk-kpi"><span>Seats booked</span><strong>{totals.seats}</strong><i>excludes cancelled</i></div>
            <div className="bk-kpi"><span>Booking value</span><strong>{money(totals.revenue)}</strong><i>{money(totals.deposits)} deposits due</i></div>
            <div className="bk-kpi"><span>Confirmed</span><strong>{counts.confirmed || 0}</strong><i>{counts.paid || 0} paid · {cancelledTotal} cancelled</i></div>
          </div>
          {truncated && (
            <p className="bk-trunc" role="status">
              Showing the {all.length.toLocaleString()} most recent of {total.toLocaleString()} bookings.
              The figures above cover all bookings; the list, search and “By tour” view below cover only the ones loaded.
            </p>
          )}

          <div className="bk-controls">
            <div className="seg-tabs">
              <button className={`seg-tab ${view === "list" ? "on" : ""}`} onClick={() => setView("list")}>Bookings</button>
              <button className={`seg-tab ${view === "tours" ? "on" : ""}`} onClick={() => setView("tours")}>By tour</button>
            </div>
            {view === "list" && (
              <div className="chip-row">
                {BOOKING_FILTERS.map((f) => (
                  <button key={f.id} className={`chip ${filter === f.id ? "on" : ""}`} onClick={() => setFilter(f.id)}>
                    {f.label}{f.id !== "all" && counts[f.id] ? <span className="chip-n">{counts[f.id]}</span> : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          {view === "list" ? (
            <div className="table-wrap">
              <table className="dash-table">
                <thead><tr><th>Customer</th><th>Route</th><th>Booked by</th><th>Seats</th><th>Total</th><th>Balance</th><th>Status</th></tr></thead>
                <tbody>
                  {shown.map((b) => (
                    <tr key={b.id} className="clickable" onClick={() => setOpen(b)}>
                      <td><strong>{b.customers || "—"}</strong>{b.customerEmail && <div className="sub">{b.customerEmail}</div>}{b.bookingCode && <div className="sub">{b.bookingCode}</div>}</td>
                      <td>{b.route}<div className="sub">{fmtDate(b.date)}</div></td>
                      <td>{b.source === "public" ? <span className="tag">Direct</span> : b.agency}</td>
                      <td>{b.seats}</td>
                      <td>{money(b.bookingTotal)}</td>
                      <td>{money(b.balanceDue)}{b.balanceDueDate && <div className="sub">by {fmtDate(b.balanceDueDate)}</div>}</td>
                      <td><span className={`tag ${bookingStatusTag(b.status)}`}>{b.status}</span></td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={7}><Empty label="No bookings found." /></td></tr>}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="bk-tours">
              {tourRows.map(({ d, fill, agg }) => (
                <div className="bk-tour" key={d.id}>
                  <div className="bk-tour-main">
                    <div className="bk-tour-title">
                      <strong>{d.route}</strong>
                      <span className="sub">{d.city} · {fmtDate(d.startDate || d.date)}{d.type === "package" ? " · package" : ""}</span>
                    </div>
                    <div className="bk-meter"><i className={`fill-${fill.tone}`} style={{ width: `${Math.min(100, (fill.seats / fill.min) * 100)}%` }} /></div>
                    <div className="bk-tour-stat"><b>{fill.seats}/{fill.min}</b><span className={`tag tag-${fill.tone === "on" ? "on" : fill.tone === "ready" ? "ready" : fill.tone === "off" ? "off" : "warn"}`}>{fill.label}</span></div>
                  </div>
                  <div className="bk-tour-side">
                    <div><span>{agg.count}</span>bookings</div>
                    <div><span>{money(agg.revenue)}</span>value</div>
                  </div>
                </div>
              ))}
              {tourRows.length === 0 && <Empty label="No booked departures yet." />}
            </div>
          )}
        </>
      )}

      {open && <BookingDrawer booking={open} onClose={() => setOpen(null)} onStatus={setStatus} />}
    </>
  );
}

function BookingDrawer({ booking: b, onClose, onStatus }) {
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div><h2>{b.customers || "Booking"}</h2><span className="sub">{b.bookingCode || b.id}</span></div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-body">
          <div className="drawer-status">
            <span className="dl">Status</span>
            <div className="seg sm">
              {BOOKING_STATUSES.map((s) => (
                <button key={s} className={b.status === s ? "active" : ""} onClick={() => onStatus(b.id, s)}>{s}</button>
              ))}
            </div>
          </div>
          <dl className="drawer-dl">
            <div><dt>Tour</dt><dd>{b.route}{b.type === "package" && <span className="tag tag-pkg">Package</span>}</dd></div>
            <div><dt>Date</dt><dd>{fmtDate(b.date)}{b.endDate ? ` – ${fmtDate(b.endDate)}` : ""}{b.time ? ` · ${b.time}` : ""}</dd></div>
            <div><dt>City</dt><dd>{b.city || "—"}</dd></div>
            <div><dt>Travellers</dt><dd>{b.seats} {b.seats === 1 ? "person" : "people"}</dd></div>
            <div><dt>Lead name</dt><dd>{b.customers || "—"}</dd></div>
            <div><dt>Email</dt><dd>{b.customerEmail || "—"}</dd></div>
            <div><dt>Phone</dt><dd>{b.customerPhone || "—"}</dd></div>
            <div><dt>Booked by</dt><dd>{b.source === "public" ? "Direct traveller" : b.agency}</dd></div>
            {b.roomingType && <div><dt>Room</dt><dd>{b.roomingType}{b.accommodationTierName ? ` · ${b.accommodationTierName}` : ""}</dd></div>}
          </dl>
          <div className="drawer-money">
            <div><span>Per person</span><strong>{money(b.pricePerPerson)}</strong></div>
            <div><span>Total</span><strong>{money(b.bookingTotal)}</strong></div>
            <div><span>Deposit ({b.depositPercent ?? "—"}%)</span><strong>{money(b.depositDue)}</strong></div>
            <div><span>Balance</span><strong>{money(b.balanceDue)}</strong></div>
            {b.balanceDueDate && <div className="full"><span>Balance due</span><strong>{fmtDate(b.balanceDueDate)}</strong></div>}
          </div>
          <p className="sub">Booked {fmtDate(b.createdAt)}</p>
        </div>
      </aside>
    </div>
  );
}

/* ---------------- Agencies ---------------- */
/* ---------------- Referrals / affiliate tracking ---------------- */
function ReferralsSection({ flash }) {
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState({ name: "", code: "", commissionPercent: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  async function load() {
    const j = await apiFetch("/admin/referrals").then((r) => r.json()).catch(() => ({ referrals: [] }));
    setRows(j.referrals || []);
  }
  useEffect(() => { load(); }, []);

  const embedSnippet = (code) =>
    `<iframe src="https://sawa.tours/embed?ref=${code}" style="width:100%;border:0;border-radius:18px;min-height:240px" loading="lazy" title="Sawa Tours"></iframe>`;
  const linkFor = (code) => `https://sawa.tours/itineraries?ref=${code}`;

  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); flash(`${label} copied to clipboard.`); }
    catch (e) { flash("Copy failed — please copy manually."); }
  }

  async function create(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const r = await apiFetch("/admin/referrals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, code: form.code || form.name, commissionPercent: Number(form.commissionPercent) || 0 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save partner.");
      setForm({ name: "", code: "", commissionPercent: "" });
      await load();
      flash(`Partner "${j.code}" saved — copy its embed code from the table.`);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  const totals = (rows || []).reduce((a, r) => ({
    visits: a.visits + r.visits, bookings: a.bookings + r.bookings,
    revenue: a.revenue + r.revenue, commission: a.commission + r.commission,
  }), { visits: 0, bookings: 0, revenue: 0, commission: 0 });

  return (
    <>
      <PageHead title="Referrals" sub="Partners who embed the Sawa widget. Each tracked code shows its click-throughs, bookings, revenue and commission." />
      <div className="dash-two">
        <div className="dash-card">
          <div className="dash-card-head"><h2>Partners</h2></div>
          <div className="table-wrap">
            <table className="dash-table">
              <thead><tr><th>Partner</th><th>Visits</th><th>Bookings</th><th>Conv.</th><th>Revenue</th><th>Rate</th><th>Est. payout</th><th></th></tr></thead>
              <tbody>
                {(rows || []).map((r) => (
                  <tr key={r.code} className={r.active ? "" : "row-archived"}>
                    <td><strong>{r.name || r.code}</strong><div className="sub">{r.code}</div></td>
                    <td>{r.visits}</td>
                    <td>{r.bookings}</td>
                    <td>{r.conversion}%</td>
                    <td>{money(r.revenue)}</td>
                    <td>{r.commissionPercent}%</td>
                    <td>{money(r.commission)}</td>
                    <td className="row-actions">
                      <button className="icon-btn" title="Copy embed code" onClick={() => copy(embedSnippet(r.code), "Embed code")}><Copy size={15} /></button>
                      <button className="icon-btn" title="Copy tracked link" onClick={() => copy(linkFor(r.code), "Tracked link")}><Share2 size={15} /></button>
                    </td>
                  </tr>
                ))}
                {rows && rows.length === 0 && <tr><td colSpan={8}><Empty label="No partners yet. Add one to generate a tracked widget." /></td></tr>}
                {rows && rows.length > 0 && (
                  <tr className="row-total">
                    <td><strong>Total</strong></td><td><strong>{totals.visits}</strong></td><td><strong>{totals.bookings}</strong></td><td></td>
                    <td><strong>{money(totals.revenue)}</strong></td><td></td><td><strong>{money(totals.commission)}</strong></td><td></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-card-head"><h2>Add partner</h2></div>
          <form className="stack-form" onSubmit={create}>
            <Field label="Partner name" full>
              <input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value, code: s.code || slugify(e.target.value) }))} placeholder="Cairo Travel Blog" />
            </Field>
            <Field label="Code (used in ?ref=)" full><input value={form.code} onChange={set("code")} placeholder="cairo-travel-blog" /></Field>
            <Field label="Commission %" full><input type="number" min="0" max="100" value={form.commissionPercent} onChange={set("commissionPercent")} placeholder="8" /></Field>
            {err && <div className="auth-error">{err}</div>}
            <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save partner"}</button>
            <p className="field-hint">After saving, use the copy buttons in the table to grab the partner's ready-to-paste embed code or tracked link.</p>
          </form>
        </div>
      </div>
    </>
  );
}

function AgenciesSection({ flash }) {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ name: "", phone: "", ownerName: "", ownerEmail: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState(null);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  async function load() {
    const r = await apiFetch("/admin/agencies");
    if (!r.ok) return;
    const j = await r.json();
    setList(j.agencies || []);
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault(); setBusy(true); setErr(""); setCreated(null);
    try {
      const r = await apiFetch("/admin/agencies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not create agency.");
      setCreated({ email: j.ownerEmail, tempPassword: j.tempPassword, name: j.agency.name });
      setForm({ name: "", phone: "", ownerName: "", ownerEmail: "" }); load(); flash("Agency created.");
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="Agencies" sub="Create partner agencies and their owner logins." />
      <div className="dash-two">
        <div className="dash-card">
          <div className="dash-card-head"><h2>All agencies</h2></div>
          <div className="table-wrap">
            <table className="dash-table">
              <thead><tr><th>Agency</th><th>Contact</th><th>Members</th><th>Status</th></tr></thead>
              <tbody>
                {(list || []).map((a) => (
                  <tr key={a.id}><td><strong>{a.name}</strong></td><td>{a.contactName}{a.phone ? <div className="sub">{a.phone}</div> : ""}</td><td>{a.staffCount}</td><td><span className="tag tag-on">{a.status}</span></td></tr>
                ))}
                {list && list.length === 0 && <tr><td colSpan={4}><Empty label="No agencies yet." /></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-card-head"><h2>New agency</h2></div>
          <form className="stack-form" onSubmit={create}>
            <Field label="Agency name" full><input value={form.name} onChange={set("name")} placeholder="Nile Star Travel" /></Field>
            <Field label="Phone (optional)" full><input value={form.phone} onChange={set("phone")} /></Field>
            <Field label="Owner name" full><input value={form.ownerName} onChange={set("ownerName")} /></Field>
            <Field label="Owner email" full><input type="email" value={form.ownerEmail} onChange={set("ownerEmail")} /></Field>
            {err && <div className="auth-error">{err}</div>}
            {created && (
              <div className="temp-pass">
                <strong>{created.name} created — {created.email}</strong>
                <p>One-time password (share securely):</p><code>{created.tempPassword}</code>
              </div>
            )}
            <button className="btn-primary" disabled={busy}>{busy ? "Creating…" : "Create agency + owner"}</button>
          </form>
        </div>
      </div>
    </>
  );
}

/* ---------------- Operations team (platform staff) ---------------- */
function OpsTeamSection({ flash, currentUserId }) {
  const [staff, setStaff] = useState(null);
  const [form, setForm] = useState({ fullName: "", email: "", role: "ops_staff" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState(null);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  async function load() {
    const r = await apiFetch("/admin/staff");
    if (!r.ok) return;
    const j = await r.json();
    setStaff(j.staff || []);
  }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault(); setBusy(true); setErr(""); setCreated(null);
    try {
      const r = await apiFetch("/admin/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not add.");
      setCreated({ email: j.staff.email, tempPassword: j.tempPassword, mode: j.emailMode });
      setForm({ fullName: "", email: "", role: "ops_staff" }); load(); flash("Team member added.");
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  async function setStatus(id, status) { await apiFetch(`/admin/staff/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }); load(); }

  return (
    <>
      <PageHead title="Operations team" sub="Sawa staff who run the platform (publish tours, confirm departures, manage agencies)." />
      <div className="dash-two">
        <div className="dash-card">
          <div className="dash-card-head"><h2>Staff</h2></div>
          <div className="table-wrap">
            <table className="dash-table">
              <thead><tr><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {(staff || []).map((m) => (
                  <tr key={m.id}>
                    <td><strong>{m.fullName || m.email}</strong><div className="sub">{m.email}</div></td>
                    <td>{m.role === "super_admin" ? "Super admin" : "Operations"}</td>
                    <td><span className={`tag ${m.status === "active" ? "tag-on" : "tag-off"}`}>{m.status}</span></td>
                    <td className="row-actions">
                      {m.id === currentUserId ? <span className="sub">You</span>
                        : m.status === "active"
                          ? <button className="btn-ghost sm" onClick={() => setStatus(m.id, "disabled")}>Disable</button>
                          : <button className="btn-ghost sm" onClick={() => setStatus(m.id, "active")}>Re-enable</button>}
                    </td>
                  </tr>
                ))}
                {staff && staff.length === 0 && <tr><td colSpan={4}><Empty label="No staff yet." /></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-card-head"><h2>Add staff</h2></div>
          <form className="stack-form" onSubmit={add}>
            <Field label="Full name" full><input value={form.fullName} onChange={set("fullName")} /></Field>
            <Field label="Email" full><input type="email" value={form.email} onChange={set("email")} /></Field>
            <Field label="Role" full>
              <select value={form.role} onChange={set("role")}>
                <option value="ops_staff">Operations</option>
                <option value="super_admin">Super admin</option>
              </select>
            </Field>
            {err && <div className="auth-error">{err}</div>}
            {created && (
              <div className="temp-pass">
                <strong>{created.email} can sign in.</strong>
                {created.mode === "live"
                  ? <p>An invite email has been sent.</p>
                  : <><p>One-time password (share securely):</p><code>{created.tempPassword}</code></>}
              </div>
            )}
            <button className="btn-primary" disabled={busy}>{busy ? "Adding…" : "Add team member"}</button>
          </form>
        </div>
      </div>
    </>
  );
}

/* ---------------- Activity / audit ---------------- */
function ActivitySection() {
  const [rows, setRows] = useState(null);
  useEffect(() => { apiFetch("/admin/audit?limit=150").then((r) => (r.ok ? r.json() : Promise.reject(r))).then((j) => setRows(j.entries || [])).catch(() => setRows([])); }, []);
  return (
    <>
      <PageHead title="Activity" sub="Every booking, confirmation, price change, and account action — who, what, when." />
      {rows === null && <DashSkeleton />}
      {rows && (
        <div className="table-wrap">
          <table className="dash-table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td className="sub">{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(e.created_at))}</td>
                  <td>{e.actor_email || "system"}{e.actor_role && <div className="sub">{e.actor_role}</div>}</td>
                  <td><span className="tag">{e.action}</span></td>
                  <td className="sub">{e.entity}{e.entity_id ? ` #${e.entity_id}` : ""}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4}><Empty label="No activity recorded yet." /></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
