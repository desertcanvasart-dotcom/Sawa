// Creates initial login accounts in Supabase Auth and links them to roles
// + agencies in app_users. Re-runnable: updates existing accounts by email.
// Run: SEED_PASSWORD='…' npm run db:seed-users
//
// These are DEVELOPMENT fixtures. They previously shared a password written
// into this file, which meant anyone reading the repository could sign in as
// admin@sawatours.test — a super_admin with full platform access — on any
// environment where this had been run. There is no longer a default: the script
// refuses to do anything without an explicit SEED_PASSWORD, and refuses to run
// against production at all.
import { pool } from "./index.js";
import { supabaseAdmin } from "../supabase.js";

const DEV_PASSWORD = process.env.SEED_PASSWORD;

// Two independent guards, because either alone has a hole: a missing NODE_ENV
// would defeat the first, and a developer who exports SEED_PASSWORD in their
// shell profile would sail past the second.
function refuseIfUnsafe() {
  const reasons = [];
  if (process.env.NODE_ENV === "production") {
    reasons.push("NODE_ENV=production — these are development fixtures, never production accounts.");
  }
  if (process.env.ALLOW_SEED_USERS !== "yes" && process.env.NODE_ENV === "production") {
    reasons.push("Set ALLOW_SEED_USERS=yes only if you genuinely mean to seed a production database.");
  }
  if (!DEV_PASSWORD) {
    reasons.push("SEED_PASSWORD is not set. There is deliberately no default — a password in the repo is a published password.");
  } else if (DEV_PASSWORD.length < 12) {
    reasons.push("SEED_PASSWORD is shorter than 12 characters.");
  }
  if (reasons.length) {
    console.error("\nseed-users refused to run:\n");
    reasons.forEach((r) => console.error("  - " + r));
    console.error("\nUsage: SEED_PASSWORD='a-long-random-string' npm run db:seed-users\n");
    process.exit(1);
  }
}

async function upsertUser({ email, password, fullName, role, agencyId }) {
  // Find or create the Supabase auth user.
  let authUser = null;
  const list = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  authUser = list.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) || null;

  if (!authUser) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
    authUser = data.user;
  } else {
    await supabaseAdmin.auth.admin.updateUserById(authUser.id, { password });
  }

  // Link to our authorization profile.
  await pool.query(
    `INSERT INTO app_users (id, email, full_name, role, agency_id, status)
     VALUES ($1,$2,$3,$4,$5,'active')
     ON CONFLICT (id) DO UPDATE SET
       email=EXCLUDED.email, full_name=EXCLUDED.full_name,
       role=EXCLUDED.role, agency_id=EXCLUDED.agency_id, status='active'`,
    [authUser.id, email, fullName, role, agencyId]
  );
  return authUser.id;
}

async function main() {
  refuseIfUnsafe();
  const created = [];

  // Platform super admin.
  await upsertUser({
    email: "admin@sawatours.test",
    password: DEV_PASSWORD,
    fullName: "Sawa Super Admin",
    role: "super_admin",
    agencyId: null,
  });
  created.push(["super_admin", "admin@sawatours.test"]);

  // One owner per agency.
  const agencies = (await pool.query(`SELECT id, name FROM agencies ORDER BY id`)).rows;
  for (const a of agencies) {
    const slug = a.id.replace(/[^a-z0-9]/gi, "");
    const email = `owner.${slug}@sawatours.test`;
    await upsertUser({
      email,
      password: DEV_PASSWORD,
      fullName: `${a.name} Owner`,
      role: "agency_owner",
      agencyId: a.id,
    });
    created.push(["agency_owner", email, a.name]);
  }

  // The password is not echoed — it was printed in full before, which put it
  // into terminal scrollback and any CI log that ever ran this.
  console.log("\nAccounts ready (all use the SEED_PASSWORD you supplied):\n");
  for (const [role, email, agency] of created) {
    console.log(`  ${role.padEnd(13)} ${email}${agency ? "  (" + agency + ")" : ""}`);
  }
  console.log("\nThese are development fixtures. Delete them before a database serves real traffic.\n");
  await pool.end();
}

main().catch((e) => {
  console.error("seed-users failed:", e.message);
  process.exit(1);
});
