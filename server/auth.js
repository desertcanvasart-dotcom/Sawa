// Express auth + authorization middleware.
//
// Identity comes from the verified Supabase JWT, never from the request body.
// This is the core of tenant isolation: an agency user's agency_id is loaded
// from their profile, so they can never act as another agency.
import { getAuthUser } from "./supabase.js";
import { pool } from "./db/index.js";

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

async function loadProfile(authUserId) {
  // agency_status: a deactivated agency's team is signed out with it, without
  // touching each login, so reactivating brings exactly the same team back.
  const r = await pool.query(
    `SELECT u.*, a.status AS agency_status FROM app_users u LEFT JOIN agencies a ON a.id = u.agency_id WHERE u.id = $1`,
    [authUserId]
  );
  return r.rows[0] || null;
}

// Attaches req.user = { id, email, role, agencyId } if a valid token is present.
// Does NOT reject when absent — use requireAuth for that. Lets public routes
// optionally see who's calling.
export async function attachUser(req, _res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return next();
    const authUser = await getAuthUser(token);
    if (!authUser) return next();
    const profile = await loadProfile(authUser.id);
    if (!profile || profile.status !== "active") return next();
    if (profile.agency_id && profile.agency_status === "inactive") return next();
    req.user = {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role,
      agencyId: profile.agency_id,
      // Model phase 2 — operator logins (migration 049). Undefined column
      // before 049 is applied, hence the fallback.
      operatorId: profile.operator_id == null ? null : Number(profile.operator_id),
    };
    next();
  } catch (err) {
    next(err);
  }
}

// Rejects if no valid, active user is attached.
export function requireAuth(req, _res, next) {
  if (!req.user) return next(new AuthError(401, "Sign in required."));
  next();
}

// Rejects unless the user has one of the allowed roles.
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new AuthError(401, "Sign in required."));
    if (!roles.includes(req.user.role)) return next(new AuthError(403, "You do not have access to this action."));
    next();
  };
}

export const isPlatform = (user) => user && (user.role === "super_admin" || user.role === "ops_staff");
export const isAgency = (user) => user && (user.role === "agency_owner" || user.role === "agency_agent");
export const isOperator = (user) => !!user && (user.role === "operator_owner" || user.role === "operator_staff");

export { AuthError };
