// The fee schedule now appears in three places. This is what stops them
// drifting.
//
// Terms §13.2 binds the default schedule only where it was disclosed — "The
// cancellation schedule displayed before you reserve, and repeated in the
// booking confirmation, applies." So the same bands have to be on the booking
// rail, in the confirmation email and in the Terms, and two of those three
// cannot import anything.
//
// A drift here is not a copy defect. Whichever version is lowest is the one a
// traveller will hold Sawa to; whichever is highest reads as a bait-and-switch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANCELLATION_BANDS, CANCELLATION_COLUMNS,
  CANCELLATION_BEFORE_GOAHEAD, CANCELLATION_QUALIFIER,
} from "../shared/cancellation-schedule.js";
import { bookingConfirmationEmail } from "./email.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// HTML entities the Terms are authored with. The authority holds real
// characters, so a comparison has to decode rather than the authority having to
// carry markup.
const decode = (s) => s
  .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
  .replace(/&rsquo;/g, "’").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

// Pull the schedule out of the Terms as data, so the assertion is about the
// numbers rather than about a string appearing somewhere on the page.
export function termsSchedule(html = read("site/terms.html")) {
  const section = html.slice(html.indexOf("13.2 After GoAhead"));
  const table = section.slice(section.indexOf("<table"), section.indexOf("</table>"));
  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)].map((c) => decode(c[1]))
  );
  return { header: rows[0], bands: rows.slice(1) };
}

test("the Terms table is the authority's table", () => {
  const { header, bands } = termsSchedule();
  assert.deepEqual(header, [CANCELLATION_COLUMNS.when, CANCELLATION_COLUMNS.charge],
    "the column headings drifted");
  assert.deepEqual(
    bands,
    CANCELLATION_BANDS.map((b) => [b.when, b.charge]),
    "site/terms.html disagrees with shared/cancellation-schedule.js — a fee schedule "
    + "saying two different things. Edit the Terms by hand; this is deliberately not rewritten."
  );
});

test("it fires — a Terms table that no longer matches", () => {
  // W3 — a parity check whose only evidence is "the real file passes" is also
  // what a check parsing nothing would report. This proves the parser reads
  // real cells and the comparison can fail.
  const tampered = read("site/terms.html").replace(
    "<td>Deposit paid</td>", "<td>Nothing at all</td>");
  const { bands } = termsSchedule(tampered);
  assert.equal(bands[0][1], "Nothing at all", "the parser is not reading the cells");
  assert.notDeepEqual(bands.map((b) => b[1]), CANCELLATION_BANDS.map((b) => b.charge));
});

test("the parser finds three bands and two columns, not an empty set", () => {
  const { header, bands } = termsSchedule();
  assert.equal(header.length, 2);
  assert.equal(bands.length, 3);
  assert.equal(CANCELLATION_BANDS.length, 3);
});

// ---- the two importable surfaces -------------------------------------------

const mail = () => bookingConfirmationEmail({
  to: "a@b.c", customerName: "A", route: "Giza", dateLabel: "Sat, Sep 12, 2026",
  seats: 2, depositDue: 13, balanceDue: 113, balanceDueDate: "2026-09-05",
  bookingCode: "SAWA-7K2QXM4T",
});

test("the confirmation email repeats the schedule, as §13.2 says it does", () => {
  const m = mail();
  // DIR-14 — a loop is a claim about every band and says nothing about whether
  // there are any. An empty authority would make the assertions below pass
  // while the mail disclosed no schedule at all, which is the exact failure
  // this whole file exists to prevent.
  assert.equal(CANCELLATION_BANDS.length, 3);
  for (const b of CANCELLATION_BANDS) {
    assert.ok(m.html.includes(b.when), `HTML mail is missing "${b.when}"`);
    assert.ok(m.html.includes(b.charge), `HTML mail is missing "${b.charge}"`);
  }
});

test("the plain-text part carries it too", () => {
  // A client showing text-only must not be a client that was never told — the
  // disclosure is what makes the schedule binding.
  const m = mail();
  assert.equal(CANCELLATION_BANDS.length, 3);   // DIR-14, as above
  for (const b of CANCELLATION_BANDS) {
    assert.ok(m.text.includes(b.when), `text mail is missing "${b.when}"`);
    assert.ok(m.text.includes(b.charge), `text mail is missing "${b.charge}"`);
  }
  assert.ok(m.text.includes(CANCELLATION_BEFORE_GOAHEAD));
});

test("the email states the free case before the fee bands", () => {
  // Almost everyone who cancels does so before GoAhead and owes nothing.
  // Leading with the bands would misdescribe the offer.
  const m = mail();
  assert.ok(m.text.indexOf(CANCELLATION_BEFORE_GOAHEAD) < m.text.indexOf(CANCELLATION_BANDS[0].when));
  assert.ok(m.html.indexOf(CANCELLATION_BEFORE_GOAHEAD.slice(0, 40)) < m.html.indexOf(CANCELLATION_BANDS[0].when));
});

test("the email says the bands are a default, not necessarily what binds", () => {
  // §13.2 — an operator's own schedule applies only where disclosed first.
  const m = mail();
  assert.ok(m.text.includes(CANCELLATION_QUALIFIER));
  // The HTML part is escaped on the way out — the qualifier's apostrophe
  // becomes &#39; — so it is unescaped before comparing. Asserting on the raw
  // string here failed while the mail was perfectly correct, which is the more
  // useful thing this line now records: the escaping is doing its job.
  const unescaped = m.html
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.ok(unescaped.includes(CANCELLATION_QUALIFIER));
  assert.ok(m.html.includes("&#39;"), "the qualifier should reach the mail escaped, not raw");
});

test("the booking rail displays it before a traveller reserves", () => {
  const src = read("src/main.jsx");
  assert.match(src, /function CancellationSchedule\(\)/);
  assert.match(src, /<CancellationSchedule \/>/, "the component must actually be rendered");
  // Its class must not be `bk-cancel` — that is the cancel BUTTON in the "seat
  // held" notice, whose rule sets border:0. Sharing it cost this block its top
  // rule and pushed this block's font-size and padding onto that button.
  assert.match(src, /<details className="bk-policy">/);
  const css = read("src/redesign.css");
  assert.ok(!/\.bk-policy\{background:none/.test(css), "the button's rule was renamed by mistake");
  assert.match(css, /\.sx \.bk-cancel\{background:none/, "the cancel button lost its own rule");
  // Inside the booking summary, not behind a link to another page: a disclosure
  // a reader has to navigate away for is one they never saw.
  const sum = src.indexOf("bk-sum");
  const comp = src.indexOf("<CancellationSchedule />");
  assert.ok(comp > sum && comp - sum < 4000, "it must sit inside the booking summary");
});

test("no surface hand-writes the numbers", () => {
  // The whole point. If a band's text is typed into a component or a template,
  // it stops being one declaration.
  for (const f of ["src/main.jsx", "server/email.js"]) {
    const src = read(f);
    for (const b of CANCELLATION_BANDS) {
      assert.ok(!src.includes(b.charge),
        `${f} hand-writes "${b.charge}" instead of importing it`);
    }
    assert.match(src, /from "\.\.\/shared\/cancellation-schedule\.js"/,
      `${f} must read the schedule from the authority`);
  }
});

test("the bands are what the client confirmed", () => {
  // A guard on the guard: every assertion above checks against the authority,
  // so this is the one place the agreed schedule is written down. Confirmed
  // 13 August 2026.
  assert.deepEqual(CANCELLATION_BANDS.map((b) => b.charge), [
    "Deposit paid",
    "Greater of the deposit or 50% of the Tour Price",
    "100% of the Tour Price",
  ]);
  assert.deepEqual(CANCELLATION_BANDS.map((b) => [b.fromDays, b.toDays]),
    [[46, null], [30, 45], [null, 29]]);
});

test("the day boundaries do not overlap or leave a gap", () => {
  // 46+, 30–45, under 30. An off-by-one here is a day on which two different
  // charges are due.
  assert.equal(CANCELLATION_BANDS[1].toDays + 1, CANCELLATION_BANDS[0].fromDays);
  assert.equal(CANCELLATION_BANDS[2].toDays + 1, CANCELLATION_BANDS[1].fromDays);
});

test("nothing charges from this table yet", () => {
  // It exists to disclose. If something later computes a refund from it, that
  // is a deliberate step and this assertion is where the reader finds out.
  const hits = [];
  for (const f of ["server/app.js", "server/domain.js", "server/jobs/cancel-unconfirmed.js"]) {
    if (read(f).includes("cancellation-schedule")) hits.push(f);
  }
  assert.deepEqual(hits, [], `${hits.join(", ")} now computes from the schedule — intended?`);
});

test("the Terms no longer claim a disclosure that does not happen", () => {
  // The clause that was flagged and held: it asserts both the booking-rail and
  // the email disclosure. Both now exist, so the open note beside it should be
  // gone rather than left describing a fixed problem.
  const terms = read("site/terms.html");
  assert.match(terms, /displayed before you reserve, and repeated in the booking confirmation/,
    "the clause itself is unchanged");
  assert.ok(!/OPEN, 13 Aug 2026/.test(terms),
    "the open note describes a gap that this change closes — remove it with the fix");
});
