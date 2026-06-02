# Packages (Multi-Day Tours) — Implementation Assessment

**Project:** Sawa Shared Tours
**Prepared:** 2026-05-27
**Status:** Awaiting business sign-off before implementation
**Audience:** Management / product owner

---

## 1. Purpose of This Document

The Sawa platform currently supports **day tours only** — every tour is a single date with a single departure time. The business needs to add **multi-day tours ("packages")** so agencies can pool customers for trips like a 3-day Cairo + Luxor itinerary or a 7-night Nile cruise.

This document explains:

1. What the current system does today.
2. Why packages don't fit the existing model.
3. The recommended approach to add them.
4. A concrete plan of work.
5. **Open questions that need a business decision before any code is written.**

Please review **Section 7 (Open Questions)** — those answers drive the rest of the work.

---

## 2. Current System Snapshot

### Technology
- **Frontend:** React 19 + Vite, a single file `src/main.jsx` (~1,400 lines), plain CSS.
- **Backend:** Plain Node.js HTTP server, single file `server/api.js` (~430 lines).
- **Database:** A single JSON file `data/db.json`. No real database, no migrations.
- **Authentication:** None. Role (Admin / Agency / Public) is chosen from a dropdown in the sidebar.
- **Languages:** English only. No Arabic / RTL support.
- **Tests:** None.

### What the product does today
The unique value of Sawa is **pooled pricing**: when multiple small agencies (or direct travellers) book seats on the same day tour, the **price per person drops automatically** as the group grows. When the group hits a minimum (currently hard-coded to **4 seats**), the tour is guaranteed to run ("GoAhead").

The lifecycle of a tour:
`open → minimum_reached → supplier_confirmed → closed / cancelled`

### Data model today (simplified)

**TourProduct** (template):
- Title, city, duration ("4 hours"), default time
- Guide, vehicle, min/max seats
- `publishedRate` (price at 4 seats), `breakPrice` (price at max seats)
- Inclusions / exclusions, deposit %

**Departure** (scheduled instance):
- A single `date` (YYYY-MM-DD) and `time` (HH:MM)
- Inherits all fields from the TourProduct
- Holds an array of `pledges` (bookings) and a status

**Pledge** (booking):
- Agency ID (or "direct_customer"), seats, customer reference
- Server computes live price, deposit (10%), and balance due (day before departure)

---

## 3. Why Packages Don't Fit Today's Model

A day tour is **mono-temporal** — one date, one time, one location, one vehicle. A package is fundamentally different on **five dimensions** that the current schema cannot express:

| Dimension | Day Tour | Package |
|---|---|---|
| **Time** | 1 date + 1 time | Start date, end date, N nights |
| **Itinerary** | Implied by the title | Day-by-day program required |
| **Lodging** | None | Hotels per city/night, room types (single / double / triple) |
| **Transport** | One shared vehicle | Inter-city transfers (flight, train, Nile cruise, van) |
| **Pricing** | Per seat, linear discount | Per person + single supplement + tiered (3★ / 4★ / 5★) |

Trying to shove packages into the day-tour schema would corrupt the meaning of fields like `date`, `time`, and `duration` and confuse every report and every UI screen downstream.

---

## 4. Recommended Approach

### Option chosen: **Polymorphic model with a `type` discriminator**

Add a single field `type: "day_tour" | "package"` to both `TourProduct` and `Departure`. Existing records default to `"day_tour"`. Package-only fields (itinerary, hotels, etc.) live alongside as optional fields.

**Why this one:**
- The valuable mechanic — pooling, dynamic pricing, GoAhead confirmation — is the **same** for packages. We extend it; we don't duplicate it.
- Reports, search, and the agency desk can show both kinds in one list with a small badge.
- It's the least disruptive to the existing booking flow that already works.

### Options considered and rejected

| Option | Why rejected |
|---|---|
| **Add optional fields, no type flag** | The `date` field becomes ambiguous (start date? only date?). Hard to validate. Hard to read. |
| **Build a fully separate `Package` entity with its own routes** | Duplicates the entire pledge / status / GoAhead pipeline. Doubles the maintenance cost. Two parallel systems drift apart over time. |

---

## 5. Plan of Work

### Phase 0 — Refactor (recommended prerequisite)
The frontend is one 1,400-line file. Adding ~600 lines of package UI to it will make it unmaintainable. Suggested: split into `components/` and `pages/` folders **before** building packages. *(See Question 5.)*

### Phase 1 — Data model
**`data/db.json`**
- `TourProduct` gains: `type`, `nights`, `cities[]`, `itinerary[]` (per day: city, title, description, meals), `accommodationTiers[]` (tier name, per-person supplement, single supplement), `transportSegments[]`.
- `Departure` gains: `type`, `startDate`, `endDate`. For day tours, `date` is unchanged.
- `Pledge` gains: `roomingType` (single / double / triple), `accommodationTier`.

### Phase 2 — Backend (`server/api.js`)
- New helper `livePriceForPackage(product, seats, tier, rooming)` — same shape as today's seat-based discount curve, plus tier surcharge and single supplement.
- `enrichDeparture` branches on `type`.
- Existing routes (`/api/departures`, `/api/admin/departures`, `/pledges`) accept the new fields; validation branches by type.
- **New** admin route to create / edit TourProducts via the UI (today they're hand-edited in JSON, which won't scale for multi-day itineraries).
- Stop assuming `GO_AHEAD_SEATS = 4` globally; fall back to per-product `minSeats` (the field already exists).

### Phase 3 — Frontend
New components:
- `PackageCard` — public catalogue tile (shows nights, cities, "from" price).
- `PackageDetail` — itinerary accordion, hotel tier picker, rooming selector, departure-date calendar.
- `PackageBookingForm` — captures rooming + tier in addition to seats.
- `AdminPackageEditor` — multi-day itinerary builder (add day, set city, set hotel, set meals).

Updates to existing screens:
- **Public site:** top-level "Day Tours / Packages" toggle; new route `/package/:id`.
- **Agency desk:** tabs for Day Tours and Packages; pledge form gains rooming + tier when the departure is a package.
- **Admin desk:** new "Publish package date" form; pricing controls extended for tier supplements.

### Phase 4 — Explicitly **out of scope** for this feature
These are pre-existing gaps. Flagging them, **not** fixing them in this work:
- Real authentication (login, sessions).
- Concurrent-write safety on `db.json`.
- Real hotel inventory / room allocation against a supplier system.
- Arabic / RTL localisation.
- Test suite.

Each of these becomes more important with packages (longer-lived, higher-value bookings), but should be planned as separate work items.

---

## 6. Risks to Be Aware Of

| Risk | Impact | Mitigation |
|---|---|---|
| No auth — anyone can switch agency from a dropdown | Higher-value package bookings are more attractive to abuse | Add auth as a separate work item before going live publicly |
| `db.json` writes are not atomic; two simultaneous bookings can corrupt the file | Lost bookings | Move to a real database (SQLite is the minimal step) — separate work item |
| No audit log | Disputes ("the price was $500 when I booked") cannot be proven | Add a simple change log when packages ship |
| Hotel allocation is manual | Overbooking risk | Treat admin as the source of truth for room blocks; build allocation tooling only if it becomes a real bottleneck |
| Single monolithic frontend file | Adding packages on top will hurt | Refactor first *(Question 5)* |

---

## 7. Open Questions — **Need a Business Decision**

These answers shape the scope and the price the customer sees. Please answer each one.

### Q1. Pricing model for packages
Which is closer to how you actually sell packages today?

- **(a) Per-person all-inclusive**, with surcharges for higher hotel tiers and for single rooms. Group discount still applies as more people pool. *(Recommended — keeps the "shared rate drops" story intact.)*
- **(b) Per-night + extras**, like an OTA. More flexible, but loses the pooling pitch.

**Your answer:**

---

### Q2. Accommodation tiers
- Fixed three tiers (3★ / 4★ / 5★) across all packages?
- Or free-form per package (e.g., "Standard / Deluxe / Cruise Suite")?

**Your answer:**

---

### Q3. Rooming options
Should the customer choose between single / double / triple rooms (with a price difference), or do we assume double-occupancy as the default and offer only a single supplement?

**Your answer:**

---

### Q4. Minimum seats for packages
Day tours need 4 seats minimum. Packages — especially Nile cruises — usually need more (8, 10, 12). The field exists per-product already. **Do you want one global default for packages, or set it per package?**

**Your answer:**

---

### Q5. Frontend refactor — yes or no?
The entire frontend is one ~1,400-line file. Adding the package UI to it is possible but will make future work slower.

- **(a) Refactor into multiple files first**, then add packages. Slower start, faster long-term. *(Recommended.)*
- **(b) Keep adding to the single file** to ship packages faster. Faster start, worse to maintain.

**Your answer:**

---

### Q6. Admin tooling for creating packages
Today, tour products are hand-edited in a JSON file. That's painful for a 7-day itinerary with hotels per night.

- **(a) Build a full admin form** (multi-day itinerary builder, hotel picker, pricing tiers) as part of this work.
- **(b) Keep JSON editing for v1** and ship the form later.

**Your answer:**

---

### Q7. Are there any other requirements I haven't captured?
For example:
- Visa / passport collection?
- Domestic flight booking inside the package?
- Per-person dietary requirements?
- Multi-currency pricing (USD / EUR / EGP)?
- Cancellation policy different from day tours?

**Your answer:**

---

## 8. Next Steps

1. You and the boss answer Questions 1–7.
2. I take those answers and produce a **detailed implementation plan** (file-by-file, with the new schema written out).
3. You approve the plan.
4. I implement in the phases above, with a working build at the end of each phase so you can review.

---

*End of assessment.*
