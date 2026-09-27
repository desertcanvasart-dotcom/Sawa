# Agency listing takeover

Fixed in branch `fix/agency-listing-takeover`. The fix is independent of the `catalogue_v2` work: it touches no migration, no flag and no phase 1–2 code.

## The issue

`POST /api/agency/tour-products` is how an agency submits a new listing or edits one of its own. When the body carries an `id`, the route checked ownership like this:

```js
if (owner.rows[0].agency_id && owner.rows[0].agency_id !== req.user.agencyId) → 403
```

A listing Sawa created itself has **no agency** (`agency_id IS NULL`). For those listings the first condition is false, so the check passed. The route then called `upsertTourProduct`, whose `ON CONFLICT (id) DO UPDATE` did three things:

1. It overwrote the listing's content: title, description, prices, itinerary, images and so on.
2. It set `status = 'pending'`. That takes the listing off the public site until an admin re-approves it, and it is not bookable in the meantime.
3. It set `agency_id` to the caller's agency, through `COALESCE(EXCLUDED.agency_id, tour_products.agency_id)`. **The agency became the listing's operator.** It is then shown as the operator on the tour page, receives the listing-approved email, owns the listing in its portal, and counts as the operating agency for the existing settlement tools, which decide who may submit cost lines.

## Who could exploit it

**Any signed-in agency user**, owner or agent, of any agency, could do this. They needed only the id of a Sawa-owned listing, and ids are public: they appear in the public payload and in tour URLs.

- Travelers and anonymous visitors could not.
- It did not expose other agencies' listings. Those already had an owner, and the check refused them.
- An admin re-approving the edit without noticing the change of owner would have made the takeover live.

## Signs of use in production

**Can't determine from this environment.** This session has no access to the production database. The only credentials it holds are for the content CMS.

The audit table does exist, so an operator with database access can check. Every submission through this route writes an `audit_log` row with `action = 'listing.submit'`, `entity_id` = the listing id, and the actor's email and role. Admin saves write other actions. Two queries answer the question:

```sql
-- Agency submissions against listings that an admin created or saved first.
-- An agency that legitimately owns a listing created it through listing.submit.
SELECT s.created_at, s.actor_email, s.actor_role, s.entity_id, s.detail->>'title' AS submitted_title
  FROM audit_log s
 WHERE s.action = 'listing.submit'
   AND EXISTS (SELECT 1 FROM audit_log f
                WHERE f.entity = 'tour_product' AND f.entity_id = s.entity_id
                  AND f.actor_role IN ('super_admin', 'ops_staff')
                  AND f.created_at < s.created_at
                  AND NOT EXISTS (SELECT 1 FROM audit_log g
                                   WHERE g.action = 'listing.submit' AND g.entity_id = s.entity_id
                                     AND g.created_at < f.created_at))
 ORDER BY s.created_at;

-- Listings now owned by an agency whose first recorded action was by staff.
SELECT t.id, t.title, t.agency_id, t.status, t.submitted_at
  FROM tour_products t
 WHERE t.agency_id IS NOT NULL
   AND (SELECT actor_role FROM audit_log a WHERE a.entity = 'tour_product' AND a.entity_id = t.id
         ORDER BY a.created_at LIMIT 1) IN ('super_admin', 'ops_staff');
```

Both queries returning no rows means no sign of use. The check only covers the period `audit_log` has existed, since migration 003.

Rows returned are not proof of abuse. An admin may have assigned an operator on purpose (`PATCH /api/admin/tour-products` with an agency), and the agency then edited its own listing. Check each row against that.

## The fix

`server/app.js`, `POST /api/agency/tour-products`: an agency may edit a listing only when `agency_id` **equals** its own agency. A NULL owner no longer passes. The owner row is read `FOR UPDATE`, so ownership can't change between the check and the write.

The same NULL-owner gap was closed in two more places. Neither is exploitable today, because the `agency_required_for_agency_roles` constraint guarantees that every agency login has an agency, but they now refuse on their own if that ever changes:

- `GET /api/cost-receipts/:costId`: an agency login with no agency would have matched receipts Sawa entered (also no agency).
- `loadAgencyStaff` (behind `PATCH` and `DELETE /api/agency/staff/:id`): a caller with no agency would have matched platform staff, who have no agency.

**Test:** `server/listing-ownership.integration.test.js` runs the real server against Postgres.

- Before the fix, the first test failed: the takeover returned `201` and the listing changed owner.
- After the fix it answers `403`, and the listing is unchanged.
- The other tests confirm that another agency's listing is still refused, and that an agency still creates and edits its own listings.

## Routes checked

"Scoped" means the query filters on the caller's own agency or operator from the session, never on an id from the request.

**Agency routes**

| Route | Ownership check | Result |
|---|---|---|
| `POST /api/agency/tour-products` | Listing owner equals the caller's agency | **Was broken for Sawa-owned listings; fixed** |
| `GET /api/agency/tour-products` | Scoped to the caller's agency | OK |
| `PATCH /api/agency/profile` | Scoped to the caller's agency | OK |
| `POST /api/departures/:id/pledges` | The agency comes from the session, never the body. Booking any open departure is intended (agencies resell). | OK |
| `POST /api/agency/bookings/:pledgeId/cancel` | Booking's agency equals the caller's; otherwise 404 | OK |
| `POST /api/agency/departure-requests`, `GET` | The agency comes from the session; the list is scoped | OK |
| `GET /api/agency/widget`, `/payments`, `/money` | Scoped to the caller's agency | OK |
| `GET`/`POST /api/agency/staff` | Scoped; a new user always joins the owner's own agency | OK |
| `PATCH`/`DELETE /api/agency/staff/:id` | Target's agency equals the caller's | OK; NULL guard added |
| `POST /api/cost-receipts` | The storage key is prefixed with the caller's agency | OK |
| `GET /api/cost-receipts/:costId` | Cost line's submitting agency equals the caller's | OK; NULL guard added |
| `POST /api/agency/departures/:depId/costs` | The caller must be the departure's operating agency; an attached receipt must be under the caller's own prefix (`mayAttachReceipt`) | OK |

**Operator portal routes (phase 2)**

| Route | Ownership check | Result |
|---|---|---|
| All `/api/operator/*` | Operator roles only; the operator comes from the session; 404 with the flag off | OK |
| `GET /api/operator/me`, `/roster`, `/swaps`, `/notifications` | Scoped to the caller's operator | OK |
| `GET /api/operator/assignments` | Scoped to the caller's operator | OK |
| `POST /api/operator/assignments/:id/acknowledge` | Assignment's operator equals the caller's; otherwise 404 | OK |
| `GET /api/operator/departures/:id/manifest` | Only a live assignment held by the caller, within the 90-day window | OK |
| `GET /api/operator/swap-targets` | The roster entry must be the caller's | OK |
| `POST /api/operator/swaps` | The roster entry must be the caller's | OK |
| `POST /api/operator/notifications/:id/read` | The update is filtered on the caller's operator | OK |

**Admin routes (82 in total)**

| Route | Check | Result |
|---|---|---|
| Every `/api/admin/*` route: 46 in `app.js`, 11 in `catalogue-routes.js`, 25 in `operator-routes.js` | `requireRole` for platform staff; user and agency management is super-admin only | OK. No admin route is reachable by an agency or operator login. |
| `GET /api/admin/operators/:id/documents/:docId/file` | The document must belong to that operator | OK |

**Public routes**

| Route | Check | Result |
|---|---|---|
| `GET`/`POST /api/public/bookings/:code...` | By the random booking code only | OK |
| `GET /api/public/tour-products/:id` | Served from the redacted public payload | OK |
