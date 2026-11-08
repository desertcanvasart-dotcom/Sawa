# Daily Sawa blog series

67 articles from the supplied final Markdown folder. The two notes-only folders
are merged articles, not missing content: five days in Egypt is part of the
seven-day itinerary; Aswan to Luxor by road is part of the Luxor to Aswan guide.
Their old URLs redirect only after the destination article becomes public.

## Publication

The first article, Small-Group Tours in Egypt, releases on deployment after
21:00 Cairo on 8 November 2026. The other 66 release at 09:00 Cairo daily,
9 November 2026 through 13 January 2027. All dates use the correct winter
UTC+02:00 offset. See `daily-publication-schedule.csv` and
`content/blog-schedule.json` for the complete order.

The deploy importer inserts the batch once, in the existing deploy transaction,
with a migration marker and advisory lock. It refuses collisions and never
overwrites an existing post or draft. A failed deployment rolls back the batch.
The marker means later deploys do not re-import deleted or edited posts.

Posts are stored with status `published` and a future `published_at`. Every
public query checks the database clock: page metadata, server-rendered article,
API article, API list, blog index and sitemap. No cron job, browser clock or
daily deployment is needed. Future articles return 404. Blog responses bypass
the stale page cache so the release is visible on the first request after its
timestamp. Other website routes retain their existing cache behavior.

Blog-to-blog links in article bodies become plain text until the target's
scheduled release. Schedule data controls those links; database publication
dates control actual access. To move a date after import, update both the
article's database `published_at` and its schedule entry. Setting database status
to `draft` keeps the article private. Editing repository JSON alone does not
overwrite the already imported database article.

## Editorial preparation

- Separate Sources sections are removed from the new articles and, once on
  deploy, older published articles. Original source documents remain untouched.
- Inline external links use government, museum, UNESCO, industry-association,
  rail-operator and public consumer-information websites. No competing tour
  agency or travel-booking marketplace is linked. Photo attribution links are
  retained for Creative Commons compliance.
- Existing internal links were checked against the live sitemap and new slugs.
  Related reading links connect relevant articles within the series.
- Most hero images use the existing site library. Three additional Commons
  photographs cover Esna, Luxor railway station and Luxor ballooning; their
  credits are visible on the articles and recorded in `image-credits.json`.
- Supplied meta titles/descriptions and 395 FAQ answers are populated in Sawa's
  existing SEO and FAQ components. Semantic tables are preserved with a
  blog-specific sanitizer and horizontally scroll inside narrow viewports.
- The drafts' three-day confirmation deadline and full-price late-cancellation
  charge conflicted with the live Terms. Blog wording follows the live Terms
  read on 8 November: seven days for day-tour confirmation; 10% deposit retained
  for cancellations less than 48 hours before departure. No policy, payment
  logic or non-blog page was changed. Package rules retain their existing scale.
- The flagged, unreviewed “collects as agent” legal assertion was omitted.
  Downriver Temple Road lunch/ticket inclusions were corrected against the live
  catalogue. Two drafts originally addressed a sister brand; their Sawa
  introductions were adapted for the user's request to publish this folder here.
- Price and timetable snapshots remain explicitly dated November 2026. They are
  not automatically rechecked on future release days. Tomb openings, transport
  schedules and advisories can change; linked official pages are provided.

## Validation

`node --test server/blog-publication.test.js server/blog-render.test.js
server/blog-images.test.js server/db/publish-private-tour-article.test.js`
and `npm run build` pass. A browser fixture checks the exact 9am release boundary
on a running server (page, API and sitemap), and all 67 mobile article layouts.
External URL checks returned 20 HTTP 200s; eight requests were blocked with 403
(US advice, UNESCO and MoneyHelper), with no 404s. Key advice and ticketing pages
were additionally inspected through browsing.

The full test suite on Windows reports 15 failures, exactly matching the
unchanged `0f4fffd` baseline; the six new tests add six passes. These existing
failures include platform/line-ending assumptions and unrelated policy checks.
