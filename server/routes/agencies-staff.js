// Agencies and staff: an agency owner's own team, and the admin's agencies, their owners and the platform staff
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { z } from "zod";
import { etaaLinkOk } from "../../shared/operators.js";
import { logAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth.js";
import { pool, withTransaction } from "../db/index.js";
import { mapAgency, isoDate } from "../db/mappers.js";
import { operatorSelectable } from "../domain.js";
import { recordFailure } from "../effect-log.js";
import { sendEmailInBackground, inviteEmail, emailMode } from "../email.js";
import { clearSeoCaches } from "../seo.js";
import { clearAuthCache } from "../supabase.js";
import { routeContext } from "../route-context.js";

const {
  app, h, writeLimiter, newStaffSchema, provisionUser, AppError, setLoginAccess, requireAdmin, parse,
} = routeContext();

// --- Agency owner: manage their own team -----------------------------------

app.get("/api/agency/staff", requireAuth, requireRole("agency_owner"), h(async (req, res) => {
  const r = await pool.query(
    `SELECT id, email, full_name, role, status, created_at
       FROM app_users WHERE agency_id = $1 ORDER BY created_at ASC`,
    [req.user.agencyId]
  );
  res.json({ staff: r.rows.map(mapStaff) });
}));

app.post("/api/agency/staff", requireAuth, requireRole("agency_owner"), writeLimiter, h(async (req, res) => {
  const input = newStaffSchema.parse(req.body || {});
  const created = await provisionUser({
    email: input.email,
    fullName: input.fullName,
    role: input.role,
    agencyId: req.user.agencyId, // always the owner's own agency — cannot target another
  });
  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [created.id])).rows[0];
  const agencyName = (await pool.query(`SELECT name FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0]?.name;
  await logAudit(req, { action: "staff.create", entity: "user", entityId: created.id, detail: { email: input.email, role: input.role, agencyId: req.user.agencyId } });
  sendEmailInBackground(inviteEmail({ to: input.email, fullName: input.fullName, agencyName, tempPassword: created.tempPassword, role: input.role }));
  res.status(201).json({ staff: mapStaff(row), tempPassword: created.tempPassword, emailMode });
}));

app.patch("/api/agency/staff/:id", requireAuth, requireRole("agency_owner"), h(async (req, res) => {
  const target = await loadAgencyStaff(req.params.id, req.user.agencyId);
  if (req.params.id === req.user.id) throw new AppError(409, "You cannot change your own role or status.");

  const role = req.body?.role;
  const status = req.body?.status;
  if (role && !["agency_owner", "agency_agent"].includes(role)) throw new AppError(422, "Invalid role.");
  if (status && !["active", "disabled"].includes(status)) throw new AppError(422, "Invalid status.");

  await pool.query(
    `UPDATE app_users SET role = COALESCE($1, role), status = COALESCE($2, status) WHERE id = $3`,
    [role || null, status || null, target.id]
  );

  // DIR-1.1 — this route SET status='disabled' AND NEVER TOUCHED THE LOGIN.
  //
  // The sweep found it; nobody was looking here. `DELETE .../staff/:id` revokes,
  // and the admin PATCH revokes, but an agency owner disabling a team member
  // through this route left their Supabase session working indefinitely, while
  // every screen in the product read `disabled`. That is the BBB1 defect in a
  // path BBB1 never named.
  const login = status && status !== target.status ? await setLoginAccess(target.id, status === "active") : undefined;

  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [target.id])).rows[0];
  // DIR-1 — actor, target, and OUTCOME. `login` is the part the audit trail
  // could not previously have answered: whether the access change took effect.
  await logAudit(req, {
    action: "staff.update", entity: "user", entityId: target.id,
    detail: {
      agencyId: req.user.agencyId,
      from: { role: target.role, status: target.status },
      to: { role: row.role, status: row.status },
      login: login ?? "unchanged",
    },
  });
  res.json({ staff: mapStaff(row), ...(login ? { login } : {}) });
}));

app.delete("/api/agency/staff/:id", requireAuth, requireRole("agency_owner"), h(async (req, res) => {
  const target = await loadAgencyStaff(req.params.id, req.user.agencyId);
  if (req.params.id === req.user.id) throw new AppError(409, "You cannot remove your own account.");
  // Deactivate (keeps history + bookings intact) and revoke the login.
  await pool.query(`UPDATE app_users SET status='disabled' WHERE id=$1`, [target.id]);
  const login = await setLoginAccess(target.id, false);
  await logAudit(req, {
    action: "staff.disable", entity: "user", entityId: target.id,
    detail: { agencyId: req.user.agencyId, email: target.email, role: target.role, login },
  });
  res.json({ ok: true, login });
}));

async function loadAgencyStaff(id, agencyId) {
  const r = await pool.query(`SELECT * FROM app_users WHERE id=$1`, [id]);
  const row = r.rows[0];
  // `!agencyId` first: a platform user has no agency, so a caller without one
  // would otherwise match them (docs/security/agency-listing-takeover.md).
  if (!agencyId || !row || row.agency_id !== agencyId) throw new AppError(404, "Team member not found.");
  return row;
}

function mapStaff(r) {
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

// --- Super admin: manage agencies + their owners ---------------------------

app.get("/api/admin/agencies", requireAuth, requireAdmin(), h(async (_req, res) => {
  const agencies = (await pool.query(`SELECT * FROM agencies ORDER BY id`)).rows.map(mapAgency);
  const users = (await pool.query(
    `SELECT agency_id, COUNT(*)::int AS staff_count,
            COUNT(*) FILTER (WHERE role='agency_owner')::int AS owner_count
       FROM app_users WHERE agency_id IS NOT NULL GROUP BY agency_id`
  )).rows;
  const byAgency = new Map(users.map((u) => [u.agency_id, u]));
  const ops = new Map((await pool.query(`SELECT agency_id, status FROM operators WHERE agency_id IS NOT NULL`)).rows.map((o) => [o.agency_id, o]));
  res.json({
    agencies: agencies.map((a) => ({
      ...a,
      staffCount: byAgency.get(a.id)?.staff_count || 0,
      ownerCount: byAgency.get(a.id)?.owner_count || 0,
      // The "Operating company" dropdown offers only these.
      operatorSelectable: operatorSelectable(a, ops.get(a.id)),
    })),
  });
}));

// Admin: list platform staff (super_admin + ops_staff).
app.get("/api/admin/staff", requireAuth, requireAdmin(), h(async (_req, res) => {
  const r = await pool.query(
    `SELECT id, email, full_name, role, status, created_at
       FROM app_users WHERE agency_id IS NULL ORDER BY created_at ASC`
  );
  res.json({ staff: r.rows.map(mapStaff) });
}));

const newOpsStaffSchema = z.object({
  email: z.string().email("A valid email is required."),
  fullName: z.string().trim().min(1, "Name is required."),
  role: z.enum(["ops_staff", "super_admin"]).default("ops_staff"),
});

// Admin: create a platform staff member (super_admin only).
app.post("/api/admin/staff", requireAuth, requireAdmin(), writeLimiter, h(async (req, res) => {
  const input = newOpsStaffSchema.parse(req.body || {});
  const created = await provisionUser({ email: input.email, fullName: input.fullName, role: input.role, agencyId: null });
  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [created.id])).rows[0];
  await logAudit(req, { action: "staff.create", entity: "user", entityId: created.id, detail: { email: input.email, role: input.role, platform: true } });
  sendEmailInBackground(inviteEmail({ to: input.email, fullName: input.fullName, agencyName: "Sawa Operations", tempPassword: created.tempPassword, role: input.role }));
  res.status(201).json({ staff: mapStaff(row), tempPassword: created.tempPassword, emailMode });
}));

// Admin: change a platform staff member's status/role (super_admin only).
app.patch("/api/admin/staff/:id", requireAuth, requireAdmin(), h(async (req, res) => {
  if (req.params.id === req.user.id) throw new AppError(409, "You cannot change your own account.");
  const target = (await pool.query(`SELECT * FROM app_users WHERE id=$1`, [req.params.id])).rows[0];
  if (!target || target.agency_id !== null) throw new AppError(404, "Staff member not found.");
  const role = req.body?.role, status = req.body?.status;
  if (role && !["ops_staff", "super_admin"].includes(role)) throw new AppError(422, "Invalid role.");
  if (status && !["active", "disabled"].includes(status)) throw new AppError(422, "Invalid status.");
  await pool.query(`UPDATE app_users SET role=COALESCE($1,role), status=COALESCE($2,status) WHERE id=$3`, [role || null, status || null, target.id]);
  // DIR-1.2 — 'active' was a one-way door here too: it wrote the row and left
  // the ban in place, so re-enabling a platform admin silently did nothing.
  const login = status && status !== target.status ? await setLoginAccess(target.id, status === "active") : undefined;
  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [target.id])).rows[0];
  await logAudit(req, {
    action: "staff.update", entity: "user", entityId: target.id,
    detail: {
      platform: true,
      from: { role: target.role, status: target.status },
      to: { role: row.role, status: row.status },
      login: login ?? "unchanged",
    },
  });
  res.json({ staff: mapStaff(row), ...(login ? { login } : {}) });
}));

const newAgencySchema = z.object({
  name: z.string().trim().min(1, "Agency name is required."),
  contactName: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  ownerEmail: z.string().email("A valid owner email is required."),
  ownerName: z.string().trim().min(1, "Owner name is required."),
});

app.post("/api/admin/agencies", requireAuth, requireAdmin(), writeLimiter, h(async (req, res) => {
  const input = newAgencySchema.parse(req.body || {});

  // Create the agency record first (its own short id), then its owner login.
  const agencyId = await withTransaction(async (c) => {
    const idRow = await c.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(id,'\\D','','g'),''))::int,0)+1 AS n FROM agencies WHERE id LIKE 'ag_%'`);
    const id = `ag_${idRow.rows[0].n}`;
    await c.query(
      `INSERT INTO agencies (id, name, contact_name, phone, status) VALUES ($1,$2,$3,$4,'active')`,
      [id, input.name, input.contactName || input.ownerName, input.phone || null]
    );
    return id;
  });

  let owner;
  try {
    owner = await provisionUser({
      email: input.ownerEmail,
      fullName: input.ownerName,
      role: "agency_owner",
      agencyId,
    });
  } catch (e) {
    // Undo the agency if owner provisioning failed, so we don't leave an ownerless agency.
    //
    // AAA1.4 — same argument as the auth rollback above: record the failed undo
    // and still throw the original cause. An ownerless agency row nobody knows
    // about is the thing worth a line in the log.
    await pool.query(`DELETE FROM agencies WHERE id=$1`, [agencyId]).catch((err) => {
      recordFailure("agencyRollback", `ownerless agency ${agencyId}: ${err.message}`);
    });
    throw e;
  }

  const agencyRow = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [agencyId])).rows[0];
  await logAudit(req, { action: "agency.create", entity: "agency", entityId: agencyId, detail: { name: input.name, ownerEmail: input.ownerEmail } });
  sendEmailInBackground(inviteEmail({ to: input.ownerEmail, fullName: input.ownerName, agencyName: input.name, tempPassword: owner.tempPassword, role: "agency_owner" }));
  res.status(201).json({ agency: mapAgency(agencyRow), ownerEmail: input.ownerEmail, tempPassword: owner.tempPassword, emailMode });
}));

// Admin: delete an agency — its own logins go with it; history blocks it.
//
// Two different kinds of dependent, treated differently on purpose:
//
// - **Team logins.** app_users.agency_id is ON DELETE CASCADE (002), so a bare
//   DELETE would erase the profiles while the Supabase logins kept working — a
//   ghost login, the exact BBB1 shape. And there is no admin route for another
//   agency's staff, so "remove them first" was a dead end from this dashboard.
//   The delete therefore revokes each login itself (same ban as staff.disable)
//   BEFORE the row goes; if any revocation fails, nothing is deleted.
//
// - **History** — tour products, bookings, and any referral code with a
//   booking attributed to it. Those carry agency_id (or ref_code) with no FK;
//   deleting would leave dangling ids nothing can resolve. Still refused.
//   Delete is "undo a mistaken creation", not a shredder for records.
//
// - **Scaffolding** — the referral code every agency gets at creation. With
//   zero bookings attributed it is furniture, not history (blocking on it made
//   every agency undeletable, discovered on second use), so an unused code is
//   deleted with its agency and listed in the audit detail. One booking
//   carrying the code moves it to the history column above.
// The operator record: licence, ETAA registration, insurance, verification.
//
// A separate route from agency creation on purpose. Creating an agency is an
// account action (it provisions an owner login); this records what Sawa has
// CHECKED about a company, and the two are done by different people at
// different times — verification usually days after the account exists.
//
// `verificationState` and `verifiedAt` move together and only here. A card that
// reads "Verified operator" above a row nobody assessed is exactly what the
// product page's old operator card was deleted for, so the state is never
// inferred from the presence of a licence number.
const operatorRecordSchema = z.object({
  relationship: z.enum(["operator"]).nullish(),
  tourismLicenseNo: z.string().trim().max(64).nullish(),
  // A YEAR, not a date: an Egyptian tourism licence does not expire (035).
  tourismLicenseYear: z.coerce.number().int().min(1900).max(2200).nullish(),
  etaaRegistrationNo: z.string().trim().max(64).nullish(),
  // 068: the company's ETAA register entry, as a link on ETAA's own site.
  etaaUrl: z.string().trim().max(500).nullish()
    .refine((v) => !v || etaaLinkOk(v), "The ETAA link must be an https link on www.etaa-egypt.org."),
  insuranceInsurer: z.string().trim().max(120).nullish(),
  insurancePolicyNo: z.string().trim().max(64).nullish(),
  insuranceExpires: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  trackRecord: z.string().trim().max(2000).nullish(),
  // The three the CHECK constraint allows (025). "in_review" was invented here
  // and does not exist in the database — the form offered it, the route
  // accepted it, and Postgres rejected the write with a constraint violation
  // the admin could do nothing about. "lapsed" is the one that was missing,
  // and it is the one that matters: an insurance policy runs out.
  verificationState: z.enum(["verified", "rejected", "lapsed"]).nullish(),
  verificationEvidence: z.string().trim().max(2000).nullish(),
});

// The company's ETAA register link (068). Clearing it clears the old "ETAA
// no." too, which the page would otherwise build the link from. Before 068
// there is no link column: a link can't be saved yet, and clearing still works.
async function saveEtaaLink(c, agencyId, url) {
  await c.query("SAVEPOINT etaa_link");
  try {
    return (await c.query(
      `UPDATE agencies SET etaa_url = $2::text, etaa_registration_no = CASE WHEN $2::text IS NULL THEN NULL ELSE etaa_registration_no END
        WHERE id = $1 RETURNING *`, [agencyId, url])).rows[0];
  } catch (e) {
    if (e?.code !== "42703") throw e;
    await c.query("ROLLBACK TO SAVEPOINT etaa_link");
    if (url) throw new AppError(503, "The ETAA link isn't switched on yet: migration 068 has not been applied to this database.");
    return (await c.query("UPDATE agencies SET etaa_registration_no = NULL WHERE id = $1 RETURNING *", [agencyId])).rows[0];
  }
}

app.patch("/api/admin/agencies/:id", requireAuth, requireAdmin(), writeLimiter, h(async (req, res) => {
  const input = parse(operatorRecordSchema, req.body || {});
  const blank = (v) => (v === "" || v === undefined ? null : v);

  const row = await withTransaction(async (c) => {
    const found = await c.query("SELECT * FROM agencies WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!found.rowCount) throw new AppError(404, "Agency not found.");

    // verified_at is set by the SERVER at the moment the state becomes
    // "verified", never accepted from the client: a verification date is
    // evidence about when someone looked, and a caller that could choose it
    // could date a check that never happened.
    const wasVerified = found.rows[0].verification_state === "verified";
    const nowVerified = blank(input.verificationState) === "verified";
    const verifiedAt = nowVerified
      ? (wasVerified ? found.rows[0].verified_at : new Date().toISOString())
      : null;

    const r = await c.query(
      `UPDATE agencies SET
         relationship            = COALESCE($2, relationship),
         tourism_license_no      = $3,
         tourism_license_year    = $4,
         -- 068: no longer entered (ETAA has no member no.); kept unless sent.
         etaa_registration_no    = COALESCE($5, etaa_registration_no),
         insurance_insurer       = $6,
         insurance_policy_no     = $7,
         insurance_expires       = $8,
         track_record            = $9,
         verification_state      = $10,
         verification_evidence   = $11,
         verified_at             = $12,
         verified_by             = CASE WHEN $10 = 'verified' THEN $13::uuid ELSE NULL END
       WHERE id=$1 RETURNING *`,
      [req.params.id, blank(input.relationship), blank(input.tourismLicenseNo),
       input.tourismLicenseYear ?? null, blank(input.etaaRegistrationNo),
       blank(input.insuranceInsurer), blank(input.insurancePolicyNo), blank(input.insuranceExpires),
       blank(input.trackRecord), blank(input.verificationState), blank(input.verificationEvidence),
       verifiedAt, req.user.id]
    );
    // The ETAA link, only when the form sent it (068).
    if (Object.hasOwn(req.body || {}, "etaaUrl")) return saveEtaaLink(c, req.params.id, blank(input.etaaUrl));
    return r.rows[0];
  });

  // The catalogue caches an operator's name and verified state into every
  // product page, so a change here must invalidate them or the site keeps
  // serving the old record.
  clearSeoCaches();
  await logAudit(req, {
    action: "agency.verification", entity: "agency", entityId: req.params.id,
    // The licence number is NOT logged. It is the one field /verify promises is
    // never shared outside Sawa, and an audit row is read by more people than
    // the form that set it.
    detail: { verificationState: row.verification_state, relationship: row.relationship },
  });
  res.json({ agency: mapAgency(row) });
}));

app.delete("/api/admin/agencies/:id", requireAuth, requireAdmin(), h(async (req, res) => {
  const id = req.params.id;
  const agency = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [id])).rows[0];
  if (!agency) throw new AppError(404, "Agency not found.");

  const [products, pledges, usedRefs] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int n FROM tour_products WHERE agency_id=$1`, [id]),
    pool.query(`SELECT COUNT(*)::int n FROM pledges WHERE agency_id=$1`, [id]),
    pool.query(
      `SELECT COUNT(*)::int n FROM referrals r
        WHERE r.agency_id=$1 AND EXISTS (SELECT 1 FROM pledges p WHERE p.ref_code = r.code)`,
      [id]
    ),
  ]);
  const blockers = [
    products.rows[0].n && `${products.rows[0].n} tour product(s) linked to it`,
    pledges.rows[0].n && `${pledges.rows[0].n} booking(s) recorded under it`,
    usedRefs.rows[0].n && `${usedRefs.rows[0].n} referral code(s) with bookings attributed`,
  ].filter(Boolean);
  if (blockers.length) {
    throw new AppError(409, `Cannot delete "${agency.name}": ${blockers.join("; ")}.`);
  }

  // Revoke every login before anything is deleted. "failed" aborts the whole
  // delete: a cascade that outruns a failed ban is exactly the ghost this
  // route exists to prevent. "no-auth-provider" (log mode) has no login to
  // outlive anything and proceeds.
  const staff = (await pool.query(`SELECT id, email, role FROM app_users WHERE agency_id=$1`, [id])).rows;
  const revoked = [];
  for (const member of staff) {
    const login = await setLoginAccess(member.id, false);
    if (login === "failed") {
      throw new AppError(502, `Could not revoke the login for ${member.email}; "${agency.name}" was not deleted. Retry once the auth provider responds.`);
    }
    revoked.push({ email: member.email, role: member.role, login });
  }

  // The unused codes and the agency row go in one transaction — a delete that
  // removed the codes and then failed on the agency would leave scaffolding
  // gone from under a row that still exists.
  const codesDeleted = await withTransaction(async (c) => {
    const codes = (await c.query(
      `DELETE FROM referrals r
        WHERE r.agency_id=$1 AND NOT EXISTS (SELECT 1 FROM pledges p WHERE p.ref_code = r.code)
        RETURNING r.code`,
      [id]
    )).rows.map((r) => r.code);
    await c.query(`DELETE FROM agencies WHERE id=$1`, [id]);
    return codes;
  });
  await logAudit(req, {
    action: "agency.delete", entity: "agency", entityId: id,
    detail: {
      name: agency.name, status: agency.status, relationship: agency.relationship ?? null,
      loginsRevoked: revoked, referralCodesDeleted: codesDeleted,
    },
  });
  res.json({ ok: true, loginsRevoked: revoked.length, referralCodesDeleted: codesDeleted.length });
}));

// What still points at an agency: the tours it operates, the bookings recorded
// under it, and its referral codes that have bookings. The delete above names
// only counts; this lists them so the screen can show each one.
app.get("/api/admin/agencies/:id/links", requireAuth, requireAdmin(), h(async (req, res) => {
  const id = req.params.id;
  const agency = (await pool.query(`SELECT id, name, status FROM agencies WHERE id=$1`, [id])).rows[0];
  if (!agency) throw new AppError(404, "Agency not found.");
  const [tours, bookings, codes] = await Promise.all([
    pool.query(`SELECT id, title, type, status, active FROM tour_products WHERE agency_id=$1 ORDER BY title`, [id]),
    pool.query(
      `SELECT p.id, p.booking_code, p.status, p.seats, p.created_at, d.id AS departure_id, d.route, d.date
         FROM pledges p LEFT JOIN departures d ON d.id = p.departure_id
        WHERE p.agency_id=$1 ORDER BY p.created_at DESC`,
      [id]
    ),
    pool.query(
      `SELECT r.code, COUNT(p.id)::int AS bookings
         FROM referrals r JOIN pledges p ON p.ref_code = r.code
        WHERE r.agency_id=$1 GROUP BY r.code ORDER BY r.code`,
      [id]
    ),
  ]);
  res.json({
    agency: { id: agency.id, name: agency.name, status: agency.status },
    tours: tours.rows.map((t) => ({ id: t.id, title: t.title, type: t.type, status: t.status, active: t.active !== false })),
    bookings: bookings.rows.map((b) => ({
      id: b.id, bookingCode: b.booking_code || null, status: b.status || null, seats: Number(b.seats),
      createdAt: b.created_at, departureId: b.departure_id ?? null, route: b.route || null, date: isoDate(b.date),
    })),
    referralCodes: codes.rows.map((r) => ({ code: r.code, bookings: r.bookings })),
  });
}));

// Take a tour off an agency: its operating company becomes "Not assigned", the
// same as choosing that in the tour editor. Works for catalogue tours too, whose
// editor hides the field. Bookings are never moved: they are history.
app.post("/api/admin/agencies/:id/tours/:tourId/unassign", requireAuth, requireAdmin(), writeLimiter, h(async (req, res) => {
  const r = await pool.query(
    `UPDATE tour_products SET agency_id = NULL WHERE id=$1 AND agency_id=$2 RETURNING id, title`,
    [req.params.tourId, req.params.id]
  );
  if (!r.rowCount) throw new AppError(404, "That tour isn't linked to this agency.");
  clearSeoCaches();
  await logAudit(req, {
    action: "listing.unassign_operator", entity: "tour_product", entityId: r.rows[0].id,
    detail: { title: r.rows[0].title, agencyId: req.params.id },
  });
  res.json({ ok: true });
}));

// The agency preferred for direct bookings (068): a traveler who books with no
// agency and no referral code counts for it, it runs a Sawa-listed tour with no
// operating company, and in the profit split it takes the direct travelers'
// share. At most one; choosing another moves the preference. Off for all: the
// DIRECT_BOOKINGS_OPERATOR setting applies, as before.
app.post("/api/admin/agencies/:id/direct-bookings", requireAuth, requireAdmin(), writeLimiter, h(async (req, res) => {
  const { preferred } = parse(z.object({ preferred: z.boolean() }), req.body || {});
  const before = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [req.params.id])).rows[0];
  if (!before) throw new AppError(404, "Agency not found.");
  if (preferred && before.status === "inactive") throw new AppError(409, "Reactivate the agency first.");
  const { row, previous } = await withTransaction(async (c) => {
    const prev = preferred
      ? (await c.query(`UPDATE agencies SET direct_bookings_preferred = false WHERE direct_bookings_preferred AND id <> $1 RETURNING id, name`, [req.params.id])).rows
      : [];
    const r = (await c.query(`UPDATE agencies SET direct_bookings_preferred = $2 WHERE id = $1 RETURNING *`, [req.params.id, preferred])).rows[0];
    return { row: r, previous: prev };
  }).catch((e) => {
    if (e?.code === "42703") throw new AppError(503, "Direct-bookings preference isn't switched on yet: migration 068 has not been applied to this database.");
    throw e;
  });
  clearSeoCaches();
  await logAudit(req, {
    action: preferred ? "agency.direct_bookings.prefer" : "agency.direct_bookings.unprefer", entity: "agency", entityId: row.id,
    detail: { name: row.name, previous: previous.map((p) => p.name) },
  });
  res.json({ agency: mapAgency(row) });
}));

// Deactivate / reactivate an agency: the way to retire one that has history.
// Nothing is deleted. While inactive its team can't sign in (auth.js) and it
// can't be chosen as a tour's operating company (operatorSelectable); its tours,
// bookings and referral codes stay as they are.
app.post("/api/admin/agencies/:id/status", requireAuth, requireAdmin(), writeLimiter, h(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["active", "inactive"]) }), req.body || {});
  const before = (await pool.query(`SELECT id, name, status FROM agencies WHERE id=$1`, [req.params.id])).rows[0];
  if (!before) throw new AppError(404, "Agency not found.");
  const row = (await pool.query(`UPDATE agencies SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id])).rows[0];
  if (status !== "active") clearAuthCache();
  clearSeoCaches();
  await logAudit(req, {
    action: status === "active" ? "agency.reactivate" : "agency.deactivate", entity: "agency", entityId: row.id,
    detail: { name: row.name, from: before.status, to: row.status },
  });
  res.json({ agency: mapAgency(row) });
}));
