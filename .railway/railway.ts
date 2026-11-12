// Sawa's Railway settings, as Infrastructure as Code.
//
// Railway stops reading railway.json on 1 December 2026. Until then it is the
// only place the service's build, start and health check are set: the service's
// own settings hold none of them (railway status, 12 Nov 2026). This file puts
// them on the service itself.
//
// Railway never reads this file during a deploy. It takes effect only through
//
//   cd .railway && npm install     (once: the SDK the CLI evaluates this with)
//   railway config plan            (read-only: what would change)
//   railway config apply           (writes the settings below to the service)
//
// Apply only on a plan with 0 to add and 0 to destroy. Applied to production on
// 12 Nov 2026; `railway config plan` then reported "already up to date".
//
// Started from `railway config pull` (12 Nov 2026), which gave the service as it
// is: source, region, domains, private networking and the names of its
// variables. Not from `railway config migrate`, whose output named the service
// after the local folder ("Sawa-main") and dropped the builder and the restart
// policy.
//
// - `partial` scopes what this file owns to the Sawa service, so an apply can
//   never delete anything this file does not declare.
// - Variables are preserve(): this file keeps their values as they are and never
//   writes one. A variable added in the dashboard later must be added here as
//   preserve() before the next apply, or the plan will propose removing it.
// - The start command runs pending migrations before the server (package.json
//   "start", server/db/migrate.js --pending). The health check is what keeps the
//   previous version serving if a new one fails to start.
import { defineRailway, github, preserve, project, service } from "railway/iac";

export const partial = "Sawa";

export default defineRailway(() => {
  const Sawa = service("Sawa", {
    source: github("desertcanvasart-dotcom/Sawa", { checkSuites: false }),
    build: {
      builder: "NIXPACKS",
      buildCommand: "npm run build",
    },
    deploy: {
      startCommand: "npm start",
      healthcheckPath: "/api/health",
      healthcheckTimeout: 100,
      // No restart policy here. Railway's default is "on failure, up to 10
      // restarts", the same as railway.json had. Declared explicitly, it was the
      // one change `railway config apply` did not store, and every later plan
      // showed it as pending; left out, the plan is clean (12 Nov 2026).
    },
    replicas: { "asia-southeast1-eqsg3a": 1 },
    domains: ["sawa.tours", "sawatours.org", "www.sawa.tours", "www.sawatours.org"],
    networking: { privateNetworkEndpoint: "sawa" },
    env: {
      APP_URL: preserve(),
      AUTOURA_BRAND_KEY: preserve(),
      AUTOURA_CAPACITY_URL: preserve(),
      AUTOURA_SYNC_SECRET: preserve(),
      AUTOURA_SYNC_URL: preserve(),
      CANONICAL_HOST: preserve(),
      CORS_ORIGINS: preserve(),
      DATABASE_URL: preserve(),
      EMAIL_FROM: preserve(),
      GOAHEAD_ALERT_DRY_RUN: preserve(),
      GOAHEAD_NOTIFY_DRY_RUN: preserve(),
      LEGACY_HOSTS: preserve(),
      NODE_ENV: preserve(),
      PGSSL: preserve(),
      RESEND_API_KEY: preserve(),
      SUPABASE_ANON_KEY: preserve(),
      SUPABASE_SERVICE_ROLE_KEY: preserve(),
      SUPABASE_URL: preserve(),
      VITE_API_BASE: preserve(),
      VITE_SUPABASE_ANON_KEY: preserve(),
      VITE_SUPABASE_URL: preserve(),
    },
  });

  return project("Sawa", {
    resources: [Sawa],
  });
});
