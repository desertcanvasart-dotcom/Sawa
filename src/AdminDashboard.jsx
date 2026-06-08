import React, { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard, Package, CalendarDays, Users, ClipboardList, ScrollText,
  Plus, Check, X, Search, Archive, ArchiveRestore, CircleDollarSign, ShieldCheck,
  TrendingUp, AlertTriangle, MapPin, Hotel, ArrowUpRight, ArrowLeft, Trash2, Pencil,
  Newspaper,
} from "lucide-react";
import { apiFetch, supabase, uploadImage } from "./supabaseClient";
import { DashSidebar } from "./DashSidebar";
import { RichText } from "./RichText";

const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString());
const fmtDate = (d) => (d ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(d)) : "—");
const isPkg = (x) => x?.type === "package";

// Meeting points are now managed per-destination (Destinations section) and the
// tour editor reads them from the selected destination.
const samePoint = (a, b) => a.point === b.point && a.note === b.note;
const seatsOf = (d) => (d.pledges || []).reduce((s, p) => s + Number(p.seats || 0), 0);
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
      { id: "destinations", label: "Destinations", icon: MapPin },
      { id: "blog", label: "Blog", icon: Newspaper },
      { id: "departures", label: "Departures", icon: CalendarDays, alert: (s) => s?.departureStatus?.readyToConfirm || 0 },
      { id: "bookings", label: "Bookings", icon: ClipboardList },
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
      const [boot, st, dest, blog] = await Promise.all([
        apiFetch("/bootstrap").then((r) => r.json()),
        apiFetch("/admin/stats").then((r) => r.json()),
        apiFetch("/admin/destinations").then((r) => r.json()).catch(() => ({ destinations: [] })),
        apiFetch("/admin/blog").then((r) => r.json()).catch(() => ({ posts: [] })),
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
            {section === "destinations" && <DestinationsSection destinations={destinations} reload={loadAll} flash={flash} />}
            {section === "blog" && <BlogSection posts={posts} reload={loadAll} flash={flash} />}
            {section === "departures" && <DeparturesSection data={data} reload={loadAll} flash={flash} />}
            {section === "bookings" && <BookingsSection />}
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
  const products = data.tourProducts || [];

  async function toggleActive(p) {
    const r = await apiFetch(`/admin/tour-products/${p.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !(p.active !== false) }),
    });
    if (r.ok) { flash(p.active !== false ? "Tour archived." : "Tour restored."); reload(); }
  }

  // Full-page editor takes over the section when adding/editing.
  if (editor) {
    return (
      <ProductEditor
        type={editor.type}
        existing={editor.existing}
        destinations={destinations}
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
              <tr key={p.id} className={p.active === false ? "row-archived" : ""}>
                <td><strong>{p.title}</strong></td>
                <td>{isPkg(p) ? <span className="tag tag-pkg">Package</span> : <span className="tag">Day tour</span>}</td>
                <td>{isPkg(p) ? (p.cities || [p.city]).join(" → ") : p.city}</td>
                <td>{money(p.publishedRate)}</td>
                <td>{money(p.breakPrice)}</td>
                <td>{p.minSeats}</td>
                <td>{p.active === false ? <span className="tag tag-off">Archived</span> : <span className="tag tag-on">Active</span>}</td>
                <td className="row-actions">
                  <button className="icon-btn" title="Edit" onClick={() => setEditor({ existing: p })}><Pencil size={15} /></button>
                  <button className="icon-btn" title={p.active === false ? "Restore" : "Archive"} onClick={() => toggleActive(p)}>
                    {p.active === false ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                  </button>
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
        <Field label="Article body" full><RichText value={bodyHtml} onChange={setBodyHtml} placeholder="Write your article — headings, bold, lists, links…" /></Field>
        <div className="form-grid">
          <Field label="Author"><input value={f.author} onChange={set("author")} placeholder="Sawa Tours" /></Field>
          <Field label="Author credentials (E-E-A-T)"><input value={f.authorCredentials} onChange={set("authorCredentials")} placeholder="Licensed Egyptologist · 10 years guiding" /></Field>
        </div>

        <div className="modal-subhead"><h3>SEO</h3></div>
        <div className="form-grid">
          <Field label="Meta title" full><input value={f.metaTitle} onChange={set("metaTitle")} placeholder="Defaults to the post title" /></Field>
          <Field label="Meta description" full><textarea rows={2} value={f.metaDescription} onChange={set("metaDescription")} placeholder="~150–160 characters for search snippets (defaults to the excerpt)." /></Field>
          <Field label="Focus keywords (comma-separated)"><input value={f.keywords} onChange={set("keywords")} placeholder="aswan day tour, philae temple" /></Field>
          <Field label="Canonical URL"><input value={f.canonicalUrl} onChange={set("canonicalUrl")} placeholder="https://sawatours.org/blog/…" /></Field>
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

function ProductEditor({ type: typeProp, existing, destinations = [], onClose, onSaved }) {
  const editing = !!existing;
  const type = existing?.type || typeProp;
  const pkg = type === "package";
  const [step, setStep] = useState(0);

  const firstDest = destinations.find((d) => d.active !== false)?.name || destinations[0]?.name || "Cairo";
  const [f, setF] = useState({
    title: existing?.title || "",
    city: existing?.city || firstDest,
    cities: (existing?.cities || ["Cairo", "Luxor"]).join(", "),
    nights: existing?.nights || 3,
    duration: existing?.duration || "",
    guide: existing?.guide || "Licensed Egyptologist",
    vehicle: existing?.vehicle || (pkg ? "Private van + flights" : "Van, 10 seats"),
    minSeats: existing?.minSeats || 4,
    maxSeats: existing?.maxSeats || (pkg ? 12 : 10),
    publishedRate: existing?.publishedRate || "",
    breakPrice: existing?.breakPrice || "",
    depositPercent: existing?.depositPercent || (pkg ? 20 : 10),
    description: existing?.description || "",
    meetingPoint: existing?.meetingPoint || "",
    pickupNote: existing?.pickupNote || "",
    bookingCutoffHours: existing?.bookingCutoffHours ?? 24,
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
  const [itinerary, setItinerary] = useState(
    existing?.itinerary?.length ? existing.itinerary
      : pkg ? [{ day: 1, city: "Cairo", title: "", description: "", meals: "Breakfast" }] : []
  );
  const [tiers, setTiers] = useState(
    existing?.accommodationTiers?.length ? existing.accommodationTiers
      : pkg ? [{ id: "standard", name: "Standard (3★)", perPersonSupplement: 0, singleSupplement: 0 }] : []
  );
  const [dates, setDates] = useState([""]); // new departures to publish on save (not for edit pre-fill)
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
        pickupNote: (meetingPoints[0]?.note || f.pickupNote || "").trim(),
        bookingCutoffHours: Number(f.bookingCutoffHours) || 0,
        images,
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
      const r = await apiFetch("/admin/tour-products", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save.");
      const productId = j.product.id;

      // Publish any first dates entered (merged create flow).
      const wantDates = clean(dates);
      for (const d of wantDates) {
        await apiFetch("/admin/departures", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pkg ? { tourProductId: productId, startDate: d } : { tourProductId: productId, date: d }),
        });
      }
      onSaved();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  const last = STEPS.length - 1;

  return (
    <div className="editor-page">
      <div className="editor-page-head">
        <button className="editor-back" onClick={onClose}><ArrowLeft size={16} />Back to Tours</button>
        <h1>{editing ? "Edit " : "New "}{pkg ? "package" : "day tour"}</h1>
        <div className="wiz-steps">
          {STEPS.map((s, i) => (
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
              <Field label="Min seats (GoAhead)"><input type="number" min="1" value={f.minSeats} onChange={set("minSeats")} /></Field>
              <Field label="Max seats (cap)"><input type="number" min="1" value={f.maxSeats} onChange={set("maxSeats")} /></Field>
              <Field label={pkg ? "GoAhead price /person" : "GoAhead price"}><input type="number" min="1" value={f.publishedRate} onChange={set("publishedRate")} /></Field>
              <Field label="Break price (full group)"><input type="number" min="1" value={f.breakPrice} onChange={set("breakPrice")} placeholder="auto = 80%" /></Field>
              <Field label="Deposit %"><input type="number" min="0" max="100" value={f.depositPercent} onChange={set("depositPercent")} /></Field>
              <Field label="Booking cutoff (hours before)"><input type="number" min="0" value={f.bookingCutoffHours} onChange={set("bookingCutoffHours")} /></Field>
              <Field label="Short description (card)" full><textarea rows={2} value={f.description} onChange={set("description")} placeholder="One-line summary shown on the tour card." /></Field>
            </div>
          )}

          {step === 1 && (
            <div className="wiz-content">
              <Field label="Cover & gallery images" full>
                <div className="img-grid">
                  {images.map((im, i) => (
                    <div className="img-thumb" key={i}>
                      <img src={im.url} alt={im.alt || ""} />
                      {i === 0 && <span className="img-cover">Cover</span>}
                      <button type="button" className="img-del" onClick={() => setImages((a) => a.filter((_, j) => j !== i))}><X size={13} /></button>
                    </div>
                  ))}
                  <label className="img-add">
                    {uploading ? "Uploading…" : "+ Add"}
                    <input type="file" accept="image/*" multiple hidden onChange={(e) => handleUpload(e.target.files)} />
                  </label>
                </div>
              </Field>
              <Field label="Overview" full><RichText value={overviewHtml} onChange={setOverviewHtml} placeholder="Describe the experience — what makes it special, what travellers will see and do." /></Field>
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
              <Field label="Cancellation & policies" full><RichText value={policiesHtml} onChange={setPoliciesHtml} placeholder="Free cancellation up to 48h before, etc." /></Field>
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
              <div className="modal-subhead">
                <h3>{editing ? "Add more dates" : "First dates"}</h3>
                <button type="button" className="btn-ghost sm" onClick={() => setDates((d) => [...d, ""])}><Plus size={14} />Add date</button>
              </div>
              <p className="field-hint">Publish one or more {pkg ? "start dates" : "dates"} for this tour. You can always add more later from the Departures tab. Each date holds up to {f.maxSeats} travellers.</p>
              {dates.map((d, i) => (
                <div className="itin-row" key={i}>
                  <input type="date" value={d} onChange={(e) => setDates((a) => a.map((x, j) => j === i ? e.target.value : x))} />
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
            {step === last && <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : editing ? "Save changes" : (pkg ? "Create package" : "Create tour")}</button>}
          </div>
        </div>
    </div>
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

function Field({ label, children, full }) {
  return <label className={`field ${full ? "field-full" : ""}`}><span>{label}</span>{children}</label>;
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
            <button className="btn-ghost" onClick={() => setPub({ type: "day_tour" })}><Plus size={16} />Publish tour date</button>
            <button className="btn-primary" onClick={() => setPub({ type: "package" })}><Plus size={16} />Publish package date</button>
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

      {pub && <PublishModal type={pub.type} data={data} onClose={() => setPub(null)} onDone={() => { setPub(null); flash("Date published."); reload(); }} />}
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function go(e) {
    e.preventDefault();
    if (!productId) return setErr("Pick a product.");
    if (!date) return setErr("Pick a date.");
    setBusy(true); setErr("");
    try {
      const body = pkg ? { tourProductId: productId, startDate: date } : { tourProductId: productId, date };
      const r = await apiFetch("/admin/departures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not publish.");
      onDone();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{pkg ? "Publish package date" : "Publish tour date"}</h2><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <form className="modal-body" onSubmit={go}>
          <Field label={pkg ? "Package" : "Tour"} full>
            <select value={productId} onChange={(e) => setProductId(e.target.value)}>
              {products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </Field>
          <Field label={pkg ? "Start date" : "Date"} full><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          {products.length === 0 && <p className="dash-empty">No active {pkg ? "packages" : "tours"}. Create one first.</p>}
          {err && <div className="auth-error">{err}</div>}
          <div className="modal-foot">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !products.length}>{busy ? "Publishing…" : "Publish"}</button>
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

function BookingsSection() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null); // selected booking

  async function load() {
    const j = await apiFetch("/admin/bookings").then((r) => r.json()).catch(() => ({ bookings: [] }));
    setRows(j.bookings || []);
    return j.bookings || [];
  }
  useEffect(() => { load(); }, []);

  const shown = (rows || []).filter((b) => {
    if (!q) return true;
    const t = `${b.route} ${b.customers} ${b.customerEmail} ${b.customerPhone} ${b.agency} ${b.bookingCode}`.toLowerCase();
    return t.includes(q.toLowerCase());
  });

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
function AgenciesSection({ flash }) {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ name: "", phone: "", ownerName: "", ownerEmail: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState(null);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  async function load() { const j = await apiFetch("/admin/agencies").then((r) => r.json()); setList(j.agencies || []); }
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

  async function load() { const j = await apiFetch("/admin/staff").then((r) => r.json()); setStaff(j.staff || []); }
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
  useEffect(() => { apiFetch("/admin/audit?limit=150").then((r) => r.json()).then((j) => setRows(j.entries || [])).catch(() => setRows([])); }, []);
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
