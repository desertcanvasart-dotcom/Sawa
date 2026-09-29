// Admin: requests for a group larger than the online maximum. Each one is a
// lead: no booking exists and no seats are held. Mark it once someone has
// replied.
import { useEffect, useState } from "react";
import { apiFetch } from "./supabaseClient";

async function call(path, method = "GET", body) {
  const r = await apiFetch(path, body === undefined ? { method } : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

export function GroupRequestsSection({ flash }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");

  async function load() {
    try { setErr(""); setRows((await call("/admin/group-requests")).requests); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function mark(id, status) {
    try { await call(`/admin/group-requests/${id}`, "PATCH", { status }); flash?.("Updated."); await load(); } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <div className="dash-head"><div><h1>Group requests</h1>
        <p>Groups of more than 8 can't book online. They ask for a special arrangement here. Nothing is booked and no seats are held.</p></div></div>
      {err && <div className="auth-error">{err}</div>}
      <div className="dash-card">
        {rows == null ? <p className="field-hint">Loading…</p> : rows.length === 0 ? <p className="field-hint">No requests yet.</p> : (
          <div className="table-wrap"><table className="dash-table">
            <thead><tr><th>Received</th><th>Name</th><th>Group</th><th>Tour</th><th>Date</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{String(r.createdAt).slice(0, 10)}</td>
                <td><strong>{r.name}</strong><div className="field-hint"><a href={`mailto:${r.email}`}>{r.email}</a></div>{r.note && <div className="field-hint">{r.note}</div>}</td>
                <td className="tnum">{r.groupSize}</td>
                <td>{r.productTitle || "—"}</td>
                <td>{r.wantedDate || "—"}</td>
                <td><span className={`tag ${r.status === "new" ? "tag-warn" : r.status === "contacted" ? "tag-ready" : "tag-off"}`}>{r.status}</span></td>
                <td>{r.status !== "closed" && <button className="btn-mini" onClick={() => mark(r.id, r.status === "new" ? "contacted" : "closed")}>{r.status === "new" ? "Mark contacted" : "Close"}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
