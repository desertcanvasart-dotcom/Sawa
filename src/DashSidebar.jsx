import React from "react";
import { LogOut, ExternalLink } from "lucide-react";

// Shopify-style grouped sidebar shared by the admin + agency dashboards.
// groups: [{ title?: string, items: [{ id, label, icon, badge?(stats), alert?(stats) }] }]
export function DashSidebar({ subtitle, groups, active, onSelect, stats, roleLabel, user, navigate, signOut, brandName = "Sawa" }) {
  const initials = (user.fullName || user.email || "?").trim().slice(0, 1).toUpperCase();

  return (
    <aside className="dash-nav">
      <div className="dash-brand">
        <span className="brand-mark">S</span>
        <div><strong>{brandName}</strong><span>{subtitle}</span></div>
      </div>

      <nav className="dash-groups">
        {groups.map((g, gi) => (
          <div className="nav-group" key={g.title || `g${gi}`}>
            {g.title && <p className="nav-group-title">{g.title}</p>}
            {g.items.map((it) => {
              const badge = it.badge ? it.badge(stats) : null;
              const alert = it.alert ? it.alert(stats) : 0;
              const isActive = active === it.id;
              return (
                <button key={it.id} className={isActive ? "nav-item active" : "nav-item"} onClick={() => onSelect(it.id)}>
                  <span className="nav-rail" aria-hidden="true" />
                  <it.icon size={18} strokeWidth={2} className="nav-ico" />
                  <span className="nav-label">{it.label}</span>
                  {alert > 0 ? <span className="nav-alert" title={`${alert} need attention`}>{alert}</span>
                    : badge != null ? <span className="nav-badge">{badge}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="dash-account">
        <div className="acct-id">
          <span className="acct-avatar">{initials}</span>
          <div className="acct-meta">
            <strong>{user.fullName || user.email}</strong>
            <span className="acct-role">{roleLabel}</span>
          </div>
        </div>
        <div className="acct-actions">
          <button onClick={() => navigate("/")}><ExternalLink size={14} />Public site</button>
          <button onClick={signOut}><LogOut size={14} />Sign out</button>
        </div>
      </div>
    </aside>
  );
}
