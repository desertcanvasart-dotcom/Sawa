// Creates initial login accounts in Supabase Auth and links them to roles
// + agencies in app_users. Re-runnable: updates existing accounts by email.
// Run: npm run db:seed-users
import { pool } from "./index.js";
import { supabaseAdmin } from "../supabase.js";

const DEV_PASSWORD = process.env.SEED_PASSWORD || "Sawa!2026";

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

  console.log("\nAccounts ready (password for all: " + DEV_PASSWORD + "):\n");
  for (const [role, email, agency] of created) {
    console.log(`  ${role.padEnd(13)} ${email}${agency ? "  (" + agency + ")" : ""}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error("seed-users failed:", e.message);
  process.exit(1);
});
