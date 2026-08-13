// Deposit, balance timing and cancellation — one policy, four surfaces.
//
// The bands, the deposit rate and the balance date now appear on the booking
// rail, in the confirmation email and in the Terms, and two of those cannot
// import anything. This is what stops them disagreeing.
//
// A drift here is not a copy defect. The charge is capped at the deposit, so a
// surface quoting the old "100% of the Tour Price" would overstate what a
// traveller owes by four times, and one quoting 20% where the system charges 25%
// understates what they are about to pay.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPackage, balanceDueDate, balanceDueDays, depositPctFor, chargeText,
  cancellationBandsFor, CANCELLATION_SCHEDULE, CANCELLATION_COLUMNS,
  CANCELLATION_BEFORE_GOAHEAD, CANCELLATION_QUALIFIER, CANCELLATION_CAP,
  DAY_TOUR_DEPOSIT_PCT, PACKAGE_DEPOSIT_PCT,
  DAY_TOUR_BALANCE_DUE_DAYS, PACKAGE_BALANCE_DUE_DAYS,
} from "../shared/booking-policy.js";
import { bookingConfirmationEmail } from "./email.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const DAY_TOUR = { type: "day_tour" };
const PKG = { type: "package" };

// ---- the policy the client confirmed ---------------------------------------

test("the rates and windows are what was agreed", () => {
  // A guard on the guard: everything below checks against these, so this is the
  // one place the agreed policy is written down. Confirmed 13 August 2026.
  assert.equal(DAY_TOUR_DEPOSIT_PCT, 10);
  assert.equal(PACKAGE_DEPOSIT_PCT, 25);
  assert.equal(DAY_TOUR_BALANCE_DUE_DAYS, 2);    // "48 hours prior to departure"
  assert.equal(PACKAGE_BALANCE_DUE_DAYS, 14);    // "2 weeks before departure"
});

test("every charge is a fraction of the DEPOSIT, never of the Tour Price", () => {
  // The client's instruction: "cap it at what we hold — deposit only, both
  // types." An earlier draft quoted "50% of total tour price" and "full amount"
  // for the late package bands; under the cap those are the deposit, and writing
  // them as price-fractions overstates the charge by up to four times.
  const all = [...CANCELLATION_SCHEDULE.day_tour, ...CANCELLATION_SCHEDULE.package];
  assert.equal(all.length, 5);   // 2 day-tour + 3 package
  for (const b of all) {
    assert.ok(Object.hasOwn(b, "ofDeposit"), `${b.when} does not state a deposit fraction`);
    assert.ok(b.ofDeposit >= 0 && b.ofDeposit <= 1, `${b.when} charges more than the deposit`);
  }
});

test("the two schedules actually differ", () => {
  // The whole point of the change. If these ever converge, one of them is wrong.
  assert.notDeepEqual(CANCELLATION_SCHEDULE.day_tour, CANCELLATION_SCHEDULE.package);
  assert.equal(cancellationBandsFor(DAY_TOUR).length, 2);
  // Three, not four: the client's "14–7 days" and "6–0 days" both resolve to the
  // deposit under the cap, so the split charged the same money twice and read as
  // an error in a fee table. Merged 13 Aug 2026.
  assert.equal(cancellationBandsFor(PKG).length, 3);
  assert.equal(cancellationBandsFor({ type: "day_tour" })[0].when, "48 hours or more before departure");
  assert.equal(cancellationBandsFor(PKG)[0].when, "30 days or more before departure");
});

test("the charge text is generated from the deposit rate, not written out", () => {
  const day = cancellationBandsFor(DAY_TOUR);
  const pkg = cancellationBandsFor(PKG);
  assert.match(chargeText(day[0], 10), /refunded in full/);
  assert.equal(chargeText(day[1], 10), "Deposit retained (10% of the Tour Price)");
  assert.equal(chargeText(pkg[1], 25), "Half the deposit (12.5% of the Tour Price)");
  assert.equal(chargeText(pkg[2], 25), "Deposit retained (25% of the Tour Price)");
  // Half of a 10% deposit is 5%, not "5.00%" — a trailing zero on a fee reads
  // as a typo, and the formatter is the only thing standing between the two.
  assert.equal(chargeText({ ofDeposit: 0.5 }, 10), "Half the deposit (5% of the Tour Price)");
});

test("a free band never claims a charge, and a charged band never reads free", () => {
  for (const type of ["day_tour", "package"]) {
    const bands = CANCELLATION_SCHEDULE[type];
    const pct = type === "package" ? PACKAGE_DEPOSIT_PCT : DAY_TOUR_DEPOSIT_PCT;
    assert.match(chargeText(bands[0], pct), /No charge/, `${type} should open free`);
    assert.ok(!/No charge/.test(chargeText(bands[bands.length - 1], pct)),
      `${type} should not end free`);
  }
});

test("the bands run from furthest-out to closest, with no gap", () => {
  // A gap is a day on which no charge is defined; an inversion is two charges
  // for the same day.
  for (const type of ["day_tour", "package"]) {
    const days = CANCELLATION_SCHEDULE[type].map((b) => b.days);
    assert.equal(days[days.length - 1], null, `${type}'s last band must run to departure`);
    const bounded = days.slice(0, -1);
    for (let i = 1; i < bounded.length; i++) {
      assert.ok(bounded[i] < bounded[i - 1], `${type} band ${i} is not closer to departure`);
    }
  }
});

// ---- balance timing --------------------------------------------------------

test("the balance falls due per type", () => {
  assert.equal(balanceDueDays(DAY_TOUR), 2);
  assert.equal(balanceDueDays(PKG), 14);
  assert.equal(balanceDueDate("2026-07-10", DAY_TOUR), "2026-07-08");
  assert.equal(balanceDueDate("2026-07-10", PKG), "2026-06-26");
});

test("an unparseable date returns null rather than a wrong day", () => {
  assert.equal(balanceDueDate("not-a-date", DAY_TOUR), null);
});

test("isPackage is the one predicate everything keys on", () => {
  assert.equal(isPackage(PKG), true);
  assert.equal(isPackage(DAY_TOUR), false);
  assert.equal(isPackage(null), null);          // falsy, and not a throw
  assert.equal(depositPctFor(PKG), 25);
  assert.equal(depositPctFor(DAY_TOUR), 10);
});

test("it is declared once — the two old copies are gone", () => {
  // isPackage and balanceDueDate were each declared in server/domain.js AND
  // src/main.jsx. check:duplication could not see them: its authority list is
  // derived from shared/, and they lived in server/. Moving them here is what
  // puts them under that check.
  for (const f of ["server/domain.js", "src/main.jsx"]) {
    const src = read(f);
    assert.ok(!/^(export )?function isPackage\(/m.test(src), `${f} still declares isPackage`);
    assert.ok(!/^(export )?function balanceDueDate\(/m.test(src), `${f} still declares balanceDueDate`);
  }
});

// ---- the Terms -------------------------------------------------------------

const decode = (s) => s
  .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&rsquo;/g, "’")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// Pull a named schedule table out of the Terms as data, so the assertion is
// about the numbers rather than a string appearing somewhere on the page.
export function termsSchedule(heading, html = read("site/terms.html")) {
  const from = html.indexOf(heading);
  assert.ok(from > -1, `the Terms have no "${heading}" table`);
  const after = html.slice(from);
  const table = after.slice(after.indexOf("<table"), after.indexOf("</table>"));
  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)].map((c) => decode(c[1]))
  );
  return { header: rows[0], bands: rows.slice(1) };
}

for (const [type, heading, pct] of [
  ["day_tour", "Day tours", DAY_TOUR_DEPOSIT_PCT],
  ["package", "Multi-day packages", PACKAGE_DEPOSIT_PCT],
]) {
  test(`the Terms table for ${heading} is the authority's`, () => {
    const { header, bands } = termsSchedule(heading);
    assert.deepEqual(header, [CANCELLATION_COLUMNS.when, CANCELLATION_COLUMNS.charge]);
    assert.deepEqual(
      bands,
      CANCELLATION_SCHEDULE[type].map((b) => [b.when, chargeText(b, pct)]),
      `site/terms.html disagrees with shared/booking-policy.js for ${heading}. `
      + "Edit the Terms by hand — this is legal text and is deliberately never rewritten."
    );
  });
}

test("it fires — a Terms table that no longer matches", () => {
  // W3 — a parity check whose only evidence is "the real file passes" is also
  // what a check parsing nothing would report.
  const tampered = read("site/terms.html").replace(
    "<td>Deposit retained (25% of the Tour Price)</td>", "<td>Nothing at all</td>");
  const { bands } = termsSchedule("Multi-day packages", tampered);
  assert.ok(bands.some((b) => b[1] === "Nothing at all"), "the parser is not reading the cells");
});

test("the Terms publish the deposit rates the system charges", () => {
  // §11. The package rate moved 20 -> 25, and the Terms are where a traveller
  // is held to it.
  // Tags stripped: the rates are wrapped in <strong>, and a reader is held to
  // the words, not the markup.
  const terms = read("site/terms.html").replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
  assert.match(terms, new RegExp(`day tours require a ${DAY_TOUR_DEPOSIT_PCT}% deposit`));
  assert.match(terms, new RegExp(`multi-day tours require a ${PACKAGE_DEPOSIT_PCT}% deposit`));
  assert.ok(!/20% deposit at GoAhead/.test(terms), "the old package rate is still published");
  // And the balance timings, which were one universal rule until 13 Aug 2026.
  assert.match(terms, new RegExp(`balance due 48 hours before departure`));
  assert.match(terms, new RegExp(`balance due ${PACKAGE_BALANCE_DUE_DAYS} days before departure`));
  assert.ok(!/the day before departure/.test(terms), "the old universal balance rule is still published");
});

test("no page still states the superseded rate or an uncapped charge", () => {
  const dead = [/\b20% deposit/i, /20% on a (multi-day|package)/i, /20% for packages/i,
    /100% of the Tour Price/i, /50% of the Tour Price/i];
  const problems = [];
  for (const f of ["site/terms.html", "site/goahead-promise.html", "site/how-it-works.html",
                   "site/faq.html", "src/main.jsx", "server/seo.js", "server/email.js"]) {
    const body = read(f).replace(/<!--[\s\S]*?-->/g, " ").replace(/^\s*\/\/.*$/gm, " ");
    for (const re of dead) if (re.test(body)) problems.push(`${f}: ${re}`);
  }
  assert.deepEqual(problems, [], problems.join("\n  "));
});

// ---- the email -------------------------------------------------------------

const mail = (product) => bookingConfirmationEmail({
  to: "a@b.c", customerName: "A", route: "R", dateLabel: "Sat, Sep 12, 2026",
  seats: 2, depositDue: 13, balanceDue: 113, balanceDueDate: "2026-09-05",
  bookingCode: "SAWA-7K2QXM4T", product,
});

test("the confirmation email prints the schedule for the product booked", () => {
  const day = mail(DAY_TOUR);
  const pkg = mail(PKG);
  assert.equal(cancellationBandsFor(PKG).length, 3);          // DIR-14
  // The package's own bands reach a package booking...
  assert.ok(pkg.text.includes("30 days or more before departure"));
  assert.ok(pkg.text.includes("Half the deposit (12.5% of the Tour Price)"));
  // ...and must NOT reach a day-tour booking.
  assert.ok(!day.text.includes("30 days or more before departure"),
    "a day tour was sent the package schedule");
  assert.ok(day.text.includes("48 hours or more before departure"));
  assert.ok(!pkg.text.includes("48 hours or more before departure"),
    "a package was sent the day-tour schedule");
});

test("both parts of the mail carry the cap", () => {
  for (const product of [DAY_TOUR, PKG]) {
    const m = mail(product);
    assert.ok(m.text.includes(CANCELLATION_CAP), "plain-text part is missing the cap");
    assert.ok(m.html.includes(CANCELLATION_CAP), "HTML part is missing the cap");
    assert.ok(m.text.includes(CANCELLATION_BEFORE_GOAHEAD));
  }
});

test("the cap is stated before the bands", () => {
  // The exposure being capped at the deposit is the thing a reader needs before
  // a table of dates.
  const m = mail(PKG);
  assert.ok(m.text.indexOf(CANCELLATION_CAP) < m.text.indexOf("30 days or more"));
});

test("a mail with no product falls back to the day-tour schedule, not to nothing", () => {
  // `product` is optional, and an omitted one must not produce a mail with an
  // empty cancellation table — silence here would be a disclosure that never
  // happened, which is what makes the schedule unenforceable.
  const m = mail(undefined);
  assert.ok(m.text.includes("48 hours or more before departure"));
  assert.ok(m.html.includes("Deposit retained"));
});

test("the email says the bands are a default, not necessarily what binds", () => {
  const m = mail(PKG);
  assert.ok(m.text.includes(CANCELLATION_QUALIFIER));
  const unescaped = m.html.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  assert.ok(unescaped.includes(CANCELLATION_QUALIFIER));
});

// ---- the booking rail ------------------------------------------------------

test("the booking rail displays the schedule for the tour being booked", () => {
  const src = read("src/main.jsx");
  assert.match(src, /function CancellationSchedule\(\{ tour, depositPct \}\)/,
    "the component must take the product, or it can only print one schedule");
  assert.match(src, /<CancellationSchedule tour=\{tour\} depositPct=\{depositPct\} \/>/);
  assert.match(src, /cancellationBandsFor\(tour\)/);
  // The percentage must come from the booking summary, NOT from the type.
  // `deposit_percent` is captured per departure, so a package published before
  // the rate moved to 25% still quotes 20% — and deriving the table from the
  // type put "Deposit retained (25%)" directly under "Deposit at GoAhead (20%)".
  assert.ok(!/const depositPct = depositPctFor\(tour\)/.test(src),
    "the table must use the departure's actual deposit, not the type default");
  const sum = src.indexOf("bk-sum");
  const comp = src.indexOf("<CancellationSchedule tour={tour}");
  assert.ok(comp > sum && comp - sum < 4000, "it must sit inside the booking summary");
});

test("no surface hand-writes a band or a rate", () => {
  for (const f of ["src/main.jsx", "server/email.js"]) {
    const src = read(f);
    for (const b of [...CANCELLATION_SCHEDULE.day_tour, ...CANCELLATION_SCHEDULE.package]) {
      assert.ok(!src.includes(b.when), `${f} hand-writes "${b.when}"`);
    }
    assert.match(src, /from "\.\.\/shared\/booking-policy\.js"/,
      `${f} must read the policy from the authority`);
  }
});

test("the class does not collide with the cancel button", () => {
  // `bk-cancel` is the cancel BUTTON in the "seat held" notice, whose rule sets
  // border:0. Naming the schedule that cost it its top rule and pushed this
  // block's font-size onto that button.
  const src = read("src/main.jsx");
  assert.match(src, /<details className="bk-policy">/);
  const css = read("src/redesign.css");
  assert.match(css, /\.sx \.bk-cancel\{background:none/, "the cancel button lost its own rule");
});

test("nothing computes a refund from the schedule yet", () => {
  // It exists to disclose. If something later charges from it, that is a
  // deliberate step and this assertion is where the reader finds out.
  const hits = ["server/app.js", "server/jobs/cancel-unconfirmed.js"]
    .filter((f) => /cancellationBandsFor|ofDeposit/.test(read(f)));
  assert.deepEqual(hits, [], `${hits.join(", ")} now computes from the schedule — intended?`);
});
