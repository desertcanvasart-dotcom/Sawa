// Feature flags, read from the environment so a flag is set per deployment and
// never by a request.
//
//   FEATURES=catalogue_v2        (comma-separated; unset = every flag off)
//
// catalogue_v2 — the Sawa catalogue and departure calendar (model phase 1).
// Off by default. Off means the public site, booking and jobs behave exactly as
// before it existed; the catalogue exists only in the admin tools.
export function featureEnabled(name, env = process.env) {
  return String(env.FEATURES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(String(name).toLowerCase());
}

export const catalogueV2Enabled = (env = process.env) => featureEnabled("catalogue_v2", env);
