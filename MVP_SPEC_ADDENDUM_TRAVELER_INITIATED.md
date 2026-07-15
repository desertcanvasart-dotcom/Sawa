# MVP Spec Addendum 1: Traveler-Initiated Departures

Extends `MVP_SPEC.md`. Status: proposed 2026-07-16.

## Problem

Admin-published dates with zero passengers are inventory fiction: they cost admin
effort, look dead on the tour board ("0 of 12"), and rot unjoined. Inverting the
flow means every departure that exists carries at least one committed traveler.

## Core Change

Departure creation is no longer admin-only. A departure is instantiated by its
**first committed pledge** — from an agency (existing flow, unchanged) or from a
traveler directly on the public site. Admin date publishing becomes optional
(kept for marketing pushes), not the primary supply mechanism.

The existing state machine is unchanged: status is already computed from pledges
(`open` → `minimum_reached` at go-ahead). Only the authorization to instantiate
and the traveler entity are new.

## Traveler Workflow

1. Traveler browses the tour catalog and picks a tour product.
2. **Join-first rule:** before any create, the site surfaces near-matches —
   same tour within ±3 days, ordered by fewest seats remaining to go-ahead.
   Joining an almost-tipped departure must always be the path of least
   resistance; creating a new one requires explicitly rejecting the matches.
3. If no match works, the traveler picks a date from **eligible dates only**
   (see Eligibility) and pledges 1+ seats with a deposit hold.
4. The departure appears on the tour board as `open` with a public share link:
   "N more travelers for this departure to go ahead."
5. At go-ahead (`minimum_reached`): deposits capture, operations proceeds to
   supplier confirmation as in the core spec.
6. At cutoff without go-ahead: departure auto-cancels (`cancelled`,
   reason `expired`), all holds released, travelers offered the nearest
   matching alternatives.

## Eligibility (which dates a traveler may pick)

- Lead time: date must be ≥ `minLeadDays` out (per tour product, default 3).
- Operating days: per tour product (e.g. no Fridays).
- Operator blackouts: dates blacked out in the operator capacity feed
  (autoura-saas `operator_capacity`) are not offered.
- Horizon: date must be ≤ `maxHorizonDays` out (default 90).
- One live traveler-created `open` departure per traveler at a time.

## Deposit Lifecycle (reuses `depositPercent` rules)

- On pledge: card **hold** for `depositDue` (existing formula). No charge.
- On `minimum_reached`: holds capture. Balance due per existing rules.
- On expiry/cancel before go-ahead: holds released automatically.
- An uncommitted pledge (no valid hold) does not count toward go-ahead.

## Data Model Deltas

- Departure: + `createdBy` (`admin` | `agency` | `traveler`), + `createdById`.
  `cutoff` (existing) doubles as the expiry deadline for traveler-created
  departures (default: `date - minLeadDays`).
- Pledge: + `travelerId` (nullable — mutually exclusive with `agencyId`),
  + `depositStatus` (`held` | `captured` | `released`).
- Traveler (new): `id`, `name`, `email`, `phone`, `verifiedAt`, `createdAt`.
  Verification: email or WhatsApp OTP before the pledge is accepted.
- Tour Product: + `minLeadDays`, + `operatingDays`, + `travelerInitiated`
  (boolean — the switch to enable per tour).

## New Screens

- Public: date picker with eligible dates + near-match join prompts.
- Public: departure share page (progress to go-ahead, join CTA).
- Traveler: minimal pledge management (view status, cancel before go-ahead).
- Admin: traveler-created departures queue (Phase A approval; Phase B monitor).

## Additional Business Rules

- Agencies may pledge into traveler-created departures and vice versa —
  one pool, regardless of who instantiated.
- Traveler cancellation before go-ahead releases the hold; after go-ahead,
  the core cancellation/refund rules apply.
- A traveler-created departure is invisible to search engines until
  `minimum_reached` (avoid indexing ghosts).

## Phasing

- **Phase A — "Request a departure":** traveler picks tour + date + contact,
  no online payment; lands as a departure pending admin approval into `open`.
  Tests demand with an approval gate before payment plumbing exists.
- **Phase B — self-service:** deposit holds + auto-open + share loop, admin
  moves to monitoring. Requires payment provider integration
  (Next Build Milestone 3).

## Metrics That Decide Success

- Tip rate: % of traveler-created departures reaching go-ahead.
- Fragmentation: average concurrent `open` departures per tour per ±3-day
  window (target ≈ 1).
- Join ratio: joins vs creates (healthy > 3:1).
- Time-to-tip: median days from creation to `minimum_reached`.

## Out of Scope (this addendum)

- Payment provider selection and refund edge-cases (Milestone 3).
- Traveler accounts beyond OTP-verified contact.
- Dynamic pricing changes (existing live shared rate rules apply unchanged).
