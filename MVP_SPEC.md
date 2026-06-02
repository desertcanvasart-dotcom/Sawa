# Sawa Shared Tours MVP Spec

## Product Goal

Sawa helps travel agencies combine small customer bookings into one safe, good-quality shared day tour. Instead of each agency refusing a booking or trying to sell an expensive private tour, agencies can pool 1-2 travelers into a shared departure with one vehicle and one guide.

## Primary Users

- Agency user: creates pooling requests, pledges customer seats, tracks confirmation.
- Operations admin: verifies suppliers, confirms vehicles/guides, manages pricing and cutoffs.
- Supplier partner: receives confirmed manifests and accepts assigned tours.
- Traveler: not an MVP login user; their details are represented through the agency.

## Core MVP Workflow

1. Admin creates popular fixed tour products that agencies frequently need.
2. Admin publishes available dates for those tour products.
3. Agency receives a customer request and adds the client to an open pooled departure.
4. Agency can cancel its own client while the departure is still not supplier-confirmed.
5. When minimum seats are reached, the departure becomes ready for supplier confirmation.
6. Operations confirms one vehicle, one guide, pickup plan, and final rate.
7. Customers can view dates as pending, almost confirmed, or go-ahead.
8. Each agency keeps ownership of its own customers while sharing operational logistics.

## Booking States

- `open`: agencies can add seat pledges.
- `minimum_reached`: enough seats are committed; operations should confirm supplier.
- `supplier_confirmed`: vehicle and guide are assigned.
- `closed`: no more seats can be added.
- `cancelled`: departure will not run.

## Data Model

### Agency

- `id`
- `name`
- `contactName`
- `phone`
- `status`

### Departure

- `id`
- `tourProductId`
- `route`
- `date`
- `time`
- `city`
- `guide`
- `vehicle`
- `minSeats`
- `maxSeats`
- `baseCost`
- `publishedRate`
- `quality`
- `cutoff`
- `status`
- `notes`
- `pledges`

### Pledge

- `id`
- `agencyId`
- `agency`
- `seats`
- `customers`
- `createdAt`

### Tour Product

- `id`
- `title`
- `city`
- `duration`
- `defaultTime`
- `guide`
- `vehicle`
- `minSeats`
- `maxSeats`
- `baseCost`
- `publishedRate`
- `quality`
- `description`

## MVP Screens

- Agency dashboard with open pooled departures.
- Departure details with capacity, live shared rate, cutoff, and manifest.
- Seat pledge form.
- Client cancellation from an agency-owned pledge.
- New pooling request form.
- Admin tour product catalog and date publishing.
- Admin queue for minimum-reached departures.
- Customer-facing tour board with pending/go-ahead status.

## Important Business Rules

- An agency can add seats only while the departure is open.
- Seat pledge cannot exceed vehicle capacity.
- Live shared rate improves as seats increase.
- Customer names are visible in the shared manifest for operations, but agency ownership remains clear.
- Supplier confirmation should happen only after minimum seats are reached.

## Next Build Milestones

1. Add admin confirmation controls.
2. Add simple agency login and agency-specific customer ownership.
3. Add payment/deposit rules.
4. Add voucher generation.
5. Add notifications for matching departures and cutoff reminders.
