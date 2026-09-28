// A small text-only PDF writer (A4, Helvetica), for settlement statements.
// No dependency: a statement is lines of text and a few rules, and a PDF of
// that is a few hundred bytes of structure.
//
//   textPdf([{ text, size?, bold?, gap? } | { rule: true }], { title })  → Buffer
//
// Characters outside Latin-1 are replaced (the standard Helvetica font has no
// Arabic glyphs); names are kept as close as the font allows.
import { BRAND } from "./brand.js";

const W = 595.28;
const H = 841.89;
const MARGIN = 50;

const ascii = (s) => String(s ?? "")
  .replace(/[‒-―]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/…/g, "...").replace(/ /g, " ").replace(/•/g, "*")
  .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const esc = (s) => ascii(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// Rough Helvetica width (average glyph ≈ 0.5em) to wrap long lines.
function wrap(text, size) {
  const max = Math.floor((W - 2 * MARGIN) / (size * 0.5));
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if ((line + " " + word).trim().length > max && line) { out.push(line); line = word; } else line = (line ? `${line} ` : "") + word;
    }
    out.push(line);
  }
  return out;
}

export function textPdf(items, { title = "Statement" } = {}) {
  const pages = [];
  let ops = [];
  let y = H - MARGIN;
  const newPage = () => { pages.push(ops); ops = []; y = H - MARGIN; };
  for (const it of items) {
    if (it.rule) {
      if (y < MARGIN + 20) newPage();
      ops.push(`0.6 w ${MARGIN} ${y.toFixed(2)} m ${W - MARGIN} ${y.toFixed(2)} l S`);
      y -= 10;
      continue;
    }
    const size = it.size || 10;
    const lead = size * 1.35;
    for (const line of wrap(it.text, size)) {
      if (y < MARGIN + lead) newPage();
      ops.push(`BT /${it.bold ? "F2" : "F1"} ${size} Tf ${MARGIN} ${y.toFixed(2)} Td (${esc(line)}) Tj ET`);
      y -= lead;
    }
    y -= it.gap ?? 2;
  }
  pages.push(ops);

  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (const p of pages) {
    const stream = p.join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(title)})/Producer (Sawa) >>`);

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// The settlement statement as PDF lines, from its snapshot.
export function statementPdf(statement) {
  const s = statement.snapshot || {};
  const egp = (n) => (n == null ? "-" : `EGP ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const eur = (n) => (n == null ? "-" : `EUR ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const items = [
    { text: `Sawa (${BRAND.legalName})`, size: 9 },
    { text: "Settlement statement", size: 18, bold: true, gap: 6 },
    { text: `${s.operator?.legalName || ""}`, size: 12, bold: true },
    { text: `${s.departure?.code || ""} ${s.departure?.title || ""}`, size: 11 },
    { text: `Departure ${s.departure?.date || ""}${s.departure?.endDate && s.departure.endDate !== s.departure.date ? ` to ${s.departure.endDate}` : ""} · specification v${s.departure?.specVersion ?? "-"} · rate card v${s.rateVersion?.version ?? "-"}`, size: 10 },
    { text: `Status: ${statement.state}${statement.sentAt ? ` · sent ${String(statement.sentAt).slice(0, 10)}` : ""}${statement.autoAccepted ? " · accepted automatically after 30 days" : ""}`, size: 10, gap: 8 },
    { rule: true },
    { text: `Travelers (${s.travelerCount ?? 0}) · band ${String(s.band || "-").replace("-", " to ")} · per traveler ${egp(s.perTraveler)}`, size: 11, bold: true, gap: 4 },
    ...(s.travelers || []).map((t, i) => ({ text: `${i + 1}. ${t.name}  (${t.booking})${t.canceledAfterCutoff ? "  canceled after the cut-off: counted" : ""}`, size: 9, gap: 0 })),
    { text: "", gap: 6 },
    { rule: true },
    { text: "Operator amount", size: 11, bold: true, gap: 4 },
    ...(s.lines || []).map((l) => ({ text: `${l.label}: ${l.qty} x ${egp(l.unit)} = ${egp(l.amount)}`, size: 10, gap: 0 })),
    { text: `Operator amount: ${egp(s.operatorAmount)}`, size: 10, bold: true, gap: 8 },
    { text: "Adjustments", size: 11, bold: true, gap: 4 },
    ...((s.adjustments || []).length ? s.adjustments.map((a) => ({
      text: `${a.kind === "reimbursement" ? "+" : "-"} ${egp(a.amountEgp)}  ${a.kind.replace("_", " ")} (${a.clauseRef}): ${a.reason}${a.evidence?.length ? ` [${a.evidence.length} evidence file${a.evidence.length === 1 ? "" : "s"}]` : ""}`, size: 9, gap: 0,
    })) : [{ text: "None", size: 9 }]),
    ...(s.capped ? [{ text: "Deductions are capped at the operator amount.", size: 9 }] : []),
    { text: "", gap: 6 },
    { rule: true },
    { text: `Operator amount ${egp(s.operatorAmount)}`, size: 10 },
    { text: `Less deductions ${egp(s.deductionsApplied)}`, size: 10 },
    { text: `Plus reimbursements ${egp(s.reimbursements)}`, size: 10 },
    { text: `Less advance ${egp(s.advance)}`, size: 10 },
    { text: `Balance ${egp(s.balance)}`, size: 13, bold: true, gap: 6 },
    // Set-off (Operator 9.4): amounts owed on other departures, taken here.
    ...((s.setoffs || []).length ? [
      { text: "Set-off against amounts owed to Sawa (clause 9.4)", size: 11, bold: true, gap: 2 },
      ...s.setoffs.map((x) => ({ text: `- ${egp(x.amountEgp)} from the ${x.payable}, for departure ${x.fromDeparture}`, size: 9, gap: 0 })),
      { text: `Net to transfer on the balance ${egp(s.netBalance)}`, size: 12, bold: true, gap: 8 },
    ] : []),
    // What the operator owes Sawa from this departure, and where it was recovered.
    ...((s.receivables || []).length ? [
      { text: "Owed to Sawa from this departure", size: 11, bold: true, gap: 2 },
      ...s.receivables.flatMap((r) => [
        { text: `${egp(r.amountEgp)}: ${r.reason} Outstanding ${egp(r.outstandingEgp)}; set off against your next advance or balance.`, size: 9, gap: 0 },
        ...(r.setOffAgainst || []).map((x) => ({ text: `   recovered ${egp(x.amountEgp)} from the ${x.payable} of ${x.departure}`, size: 9, gap: 0 })),
      ]),
      { text: "", gap: 6 },
    ] : []),
    // Phase 5: the departure's calculation, in EGP (shared/pool-model.js).
    ...(s.distribution?.model === "pool" ? [
      { rule: true },
      { text: "How this departure's money is shared (EGP)", size: 11, bold: true, gap: 4 },
      ...(s.distribution.lines || []).map((l) => ({ text: `${l.label}: ${egp(l.amountEgp)}`, size: 10, bold: l.key === "operator_entitlement" || l.key === "minimum_departure_guarantee", gap: 0 })),
      ...(s.distribution.ownAgencyShare ? [{ text: s.distribution.ownAgencyShare.note, size: 9 }] : []),
      ...(s.distribution.problem ? [{ text: `Not complete: ${s.distribution.problem}.`, size: 9 }] : []),
      { text: "", gap: 6 },
    ] : []),
    // The distribution of the departure's collections (27 Sep 2026), in EUR.
    ...(s.distribution && s.distribution.model !== "pool" ? [
      { rule: true },
      { text: "Distribution of collections (EUR)", size: 11, bold: true, gap: 4 },
      ...(s.distribution.lines || []).map((l) => ({ text: `${l.label}: ${eur(l.amountEur)}`, size: 10, bold: l.key === "agent_commission" || l.key === "minimum_departure_guarantee", gap: 0 })),
      ...(s.distribution.problem ? [{ text: `Not complete: ${s.distribution.problem}.`, size: 9 }] : []),
      ...(s.distribution.fx?.rates?.length ? [{
        text: `Operator entitlement ${egp(s.distribution.entitlementEgp)}, converted per traveler at the CBE rate on each charge date: ${s.distribution.fx.rates.map((r) => `${r.day} ${r.egpPerEur ?? "missing"}`).join("; ")} (EGP per EUR).`,
        size: 8,
      }] : []),
      { text: "", gap: 6 },
    ] : []),
    { text: "", gap: 4 },
    { text: "Amounts are in EGP from the rate card version locked when the departure's first seat was sold. This statement is accepted automatically 30 days after it is sent unless disputed in the operator portal.", size: 8 },
  ];
  return textPdf(items, { title: `Settlement ${s.departure?.code || ""} ${s.departure?.date || ""}` });
}
