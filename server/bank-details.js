// Operator bank details (model phase 3).
//
// A change is a new row, pending until an admin verifies it; only the
// verified row is used, and while a change is pending no payment to the
// operator can be recorded. The account holder must be the operator's legal
// name. Every view and change is logged, and a change emails both the
// operator and Sawa's admin (without the numbers).
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError } from "./catalogue.js";
import { getOperator, operatorRecipients } from "./operators.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const clean = (v, max) => {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
};
// "Nile Tours S.A.E." and "nile tours sae" are the same holder.
export const sameHolder = (a, b) => {
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9؀-ۿ]+/g, "");
  return !!norm(a) && norm(a) === norm(b);
};
const lastDigits = (a) => String(a.iban || a.account_number || "").replace(/\s+/g, "").slice(-4);

export const mapBankAccount = (r, { reveal = true } = {}) => ({
  id: Number(r.id), operatorId: Number(r.operator_id), holderName: r.holder_name, bankName: r.bank_name,
  accountNumber: reveal ? r.account_number : r.account_number ? `•••• ${String(r.account_number).slice(-4)}` : null,
  iban: reveal ? r.iban : r.iban ? `•••• ${String(r.iban).replace(/\s+/g, "").slice(-4)}` : null,
  swift: r.swift, state: r.state, submittedBy: r.submitted_by, submittedAt: r.submitted_at,
  decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, supersededAt: r.superseded_at,
});

async function log(c, { operatorId, accountId = null, action, user }) {
  await c.query(
    `INSERT INTO operator_bank_access_log (operator_id, account_id, action, actor_id, actor_email, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [operatorId, accountId, action, user?.id || null, user?.email || null, user?.role || "system"]);
}

// The accounts an admin or the operator sees; the view is logged.
export async function bankAccountsFor(db, operatorId, { user, reveal = true }) {
  const rows = (await db.query(
    "SELECT * FROM operator_bank_accounts WHERE operator_id = $1 ORDER BY submitted_at DESC LIMIT 20", [operatorId])).rows;
  await log(db, { operatorId, accountId: rows.find((r) => r.state === "verified")?.id || null, action: "view", user });
  return rows.map((r) => mapBankAccount(r, { reveal }));
}

export async function submitBankDetails(db, operatorId, body, { user, send = null, adminEmail = null }) {
  const op = await getOperator(db, operatorId);
  const d = {
    holderName: clean(body.holderName, 200), bankName: clean(body.bankName, 120),
    accountNumber: clean(body.accountNumber, 40), iban: clean(body.iban, 40)?.replace(/\s+/g, "").toUpperCase() || null,
    swift: clean(body.swift, 11)?.toUpperCase() || null,
  };
  if (!d.holderName || !d.bankName) throw new CatalogueError(422, "Enter the account holder and the bank.");
  if (!d.accountNumber && !d.iban) throw new CatalogueError(422, "Enter the account number or the IBAN.");
  if (d.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(d.iban)) throw new CatalogueError(422, "That IBAN doesn't look right.");
  if (d.swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(d.swift)) throw new CatalogueError(422, "A SWIFT code has 8 or 11 characters.");
  if (!sameHolder(d.holderName, op.legalName)) {
    throw new CatalogueError(422, `The account holder must be the operator's legal name (${op.legalName}).`);
  }
  const row = await inTx(db, async (c) => {
    // A new change replaces a change still waiting; the verified account stays
    // in use until this one is verified.
    await c.query("UPDATE operator_bank_accounts SET state = 'superseded', superseded_at = now() WHERE operator_id = $1 AND state = 'pending'", [operatorId]);
    const r = (await c.query(
      `INSERT INTO operator_bank_accounts (operator_id, holder_name, bank_name, account_number, iban, swift, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [operatorId, d.holderName, d.bankName, d.accountNumber, d.iban, d.swift, user?.email || null])).rows[0];
    await log(c, { operatorId, accountId: r.id, action: "submit", user });
    return r;
  });
  if (send) {
    const { bankDetailsChangedEmail } = await import("./email.js");
    const tail = lastDigits(row);
    for (const to of await operatorRecipients(db, operatorId)) {
      await send(bankDetailsChangedEmail({ to, operatorName: op.legalName, bankName: row.bank_name, lastDigits: tail, submittedBy: user?.email }));
    }
    if (adminEmail) await send(bankDetailsChangedEmail({ to: adminEmail, operatorName: op.legalName, bankName: row.bank_name, lastDigits: tail, submittedBy: user?.email, forAdmin: true }));
  }
  return mapBankAccount(row);
}

export async function decideBankDetails(db, accountId, { approve, note = null, user }) {
  return inTx(db, async (c) => {
    const a = (await c.query("SELECT * FROM operator_bank_accounts WHERE id = $1 FOR UPDATE", [accountId])).rows[0];
    if (!a || a.state !== "pending") throw new CatalogueError(409, "Only a pending change can be verified or rejected.");
    if (approve) {
      const op = await getOperator(c, Number(a.operator_id));
      if (!sameHolder(a.holder_name, op.legalName)) throw new CatalogueError(422, `The holder doesn't match the legal name (${op.legalName}).`);
      await c.query("UPDATE operator_bank_accounts SET state = 'superseded', superseded_at = now() WHERE operator_id = $1 AND state = 'verified'", [a.operator_id]);
    } else if (!String(note || "").trim()) {
      throw new CatalogueError(422, "Say why the details are rejected.");
    }
    const r = (await c.query(
      `UPDATE operator_bank_accounts SET state = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *`,
      [accountId, approve ? "verified" : "rejected", user?.email || null, note ? String(note).trim().slice(0, 500) : null])).rows[0];
    await log(c, { operatorId: Number(a.operator_id), accountId, action: approve ? "verify" : "reject", user });
    return mapBankAccount(r);
  });
}

// The account a payment may go to: the verified one, and only when no change
// is waiting for verification.
export async function payableAccount(db, operatorId) {
  const rows = (await db.query("SELECT * FROM operator_bank_accounts WHERE operator_id = $1 AND state IN ('verified', 'pending')", [operatorId])).rows;
  if (rows.some((r) => r.state === "pending")) {
    return { ok: false, reason: "The operator's bank details changed and haven't been verified yet. Verify them in Admin → Operators before recording a payment." };
  }
  const v = rows.find((r) => r.state === "verified");
  if (!v) return { ok: false, reason: "The operator has no verified bank details yet." };
  return { ok: true, accountId: Number(v.id) };
}
