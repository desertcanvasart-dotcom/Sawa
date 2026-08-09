# Seed operator removal — 8 August 2026

Five placeholder operator records were removed from the production `agencies`
table. They were seed data: fictional companies with fictional contacts and
sequential phone numbers.

## Why they went

Not because they were rendering — they were not. The anonymous bootstrap payload
strips agencies entirely (`agencies: isPlatform(user) ? … : []`), no live product
references one (`agency_id` is NULL on all 14), and nothing on the public site
reads that table. They went because the site is about to publish articles telling
readers that a listing is not a company, and it cannot itself hold companies that
do not exist.

## What was NOT removed

`ag_6` ("adham") has one `app_users` row attached, and `app_users.agency_id` is
`ON DELETE CASCADE` — deleting the agency would have destroyed a real login. The
DELETE was written to refuse any agency with a user attached, so that could not
happen even if the data had changed underneath it.

## Restore

These rows exist nowhere else. To put them back:

```sql
INSERT INTO agencies (id, name, contact_name, phone, status) VALUES ('ag_1', 'Nile Gate Travel', 'Mona Hassan', '+20 100 000 0101', 'active');
INSERT INTO agencies (id, name, contact_name, phone, status) VALUES ('ag_2', 'Cairo Discovery', 'Ahmed Salem', '+20 100 000 0102', 'active');
INSERT INTO agencies (id, name, contact_name, phone, status) VALUES ('ag_3', 'LuxWay Tours', 'Karim Adel', '+20 100 000 0103', 'active');
INSERT INTO agencies (id, name, contact_name, phone, status) VALUES ('ag_4', 'Heritage Desk', 'Laila Nabil', '+20 100 000 0104', 'active');
INSERT INTO agencies (id, name, contact_name, phone, status) VALUES ('ag_5', 'Lotus Day Trips', 'Omar Fathy', '+20 100 000 0105', 'active');
```

## State after

```
agencies:            ag_6 only (1 user attached)
live products:       14  (agency_id NULL on all)
app_users:           2
departures, pledges: 0
```

Nothing else references `agencies`: the only foreign key into it is
`app_users.agency_id`. `tour_products` and `pledges` both have an `agency_id`
column but neither is a declared FK, and neither had a non-null value.
