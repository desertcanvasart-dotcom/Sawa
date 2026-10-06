// Customer reviews (069): who can be asked, what can be uploaded, and what the
// public sees. The routes themselves are in reviews.integration.test.js.
process.env.DATABASE_URL ||= "postgres://nobody:nobody@127.0.0.1:1/none";

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  reviewBlocker, checkUpload, mediaKey, mediaKeyBelongs, mediaKind, mapPublicReview, summarize, reviewSchema,
  IMAGE_MAX_BYTES, VIDEO_MAX_BYTES,
} = await import("./reviews.js");

const booking = (over = {}) => ({ status: "confirmed", departure_status: "supplier_confirmed", date: "2026-10-01", start_date: null, end_date: null, ...over });

test("a review link is only for a booking whose tour has run", () => {
  assert.equal(reviewBlocker(booking(), "2026-10-05"), null);
  assert.equal(reviewBlocker(booking({ date: "2026-10-05" }), "2026-10-05"), null, "its last day counts");
  assert.match(reviewBlocker(booking({ date: "2026-10-06" }), "2026-10-05"), /hasn't run yet/);
  assert.match(reviewBlocker(booking({ status: "cancelled" }), "2026-10-05"), /booking was cancelled/);
  assert.match(reviewBlocker(booking({ departure_status: "cancelled" }), "2026-10-05"), /date was cancelled/);
  assert.equal(reviewBlocker(null), "Booking not found.");
});

test("a package is reviewable from its last day, not its first", () => {
  const pkg = booking({ date: "2026-10-01", start_date: "2026-10-01", end_date: "2026-10-08" });
  assert.match(reviewBlocker(pkg, "2026-10-05"), /hasn't run yet/);
  assert.equal(reviewBlocker(pkg, "2026-10-08"), null);
});

test("photos and videos are accepted within their size; anything else is refused", () => {
  assert.deepEqual(checkUpload({ contentType: "image/jpeg", size: 1000 }), { contentType: "image/jpeg", ext: "jpg", kind: "image" });
  assert.equal(checkUpload({ contentType: "video/quicktime", size: 1000 }).kind, "video");
  assert.match(checkUpload({ contentType: "image/png", size: IMAGE_MAX_BYTES + 1 }).error, /larger than 10MB/);
  assert.equal(checkUpload({ contentType: "video/mp4", size: IMAGE_MAX_BYTES + 1 }).error, undefined, "a video may be larger than a photo");
  assert.match(checkUpload({ contentType: "video/mp4", size: VIDEO_MAX_BYTES + 1 }).error, /larger than 50MB/);
  assert.match(checkUpload({ contentType: "text/html", size: 10 }).error, /Add a photo/);
  assert.match(checkUpload({ contentType: "image/jpeg", size: 0 }).error, /empty/);
});

test("a review can only attach files uploaded through its own link", () => {
  const key = mediaKey(42, "mp4");
  assert.ok(mediaKeyBelongs(key, 42));
  assert.ok(!mediaKeyBelongs(key, 43), "another review's file");
  assert.ok(!mediaKeyBelongs("reviews/42/../../cost-receipts/x.pdf", 42), "a crafted path");
  assert.ok(!mediaKeyBelongs("reviews/42/1-abc.exe", 42));
  assert.equal(mediaKind(key), "video");
  assert.equal(mediaKind(mediaKey(42, "jpg")), "image");
});

test("the public never sees the email, the booking or the exact date", () => {
  const out = mapPublicReview({
    id: "7", rating: 5, title: null, body: "Wonderful day.", display_name: "Ann", country: "UK",
    tour_date: new Date("2026-10-01T00:00:00Z"), email: "ann@example.com", pledge_id: "p1",
    media: [{ key: "reviews/7/1-ab.jpg", kind: "image" }],
  });
  assert.deepEqual(out, {
    id: 7, rating: 5, title: null, body: "Wonderful day.", displayName: "Ann", country: "UK", traveledOn: "2026-10",
    media: [{ kind: "image", url: "/api/public/review-media/7/0" }],
  });
});

test("the average is of published reviews only, and absent when there are none", () => {
  assert.deepEqual(summarize([]), { count: 0, average: null });
  assert.deepEqual(summarize([{ rating: 5 }, { rating: 4 }, { rating: 4 }]), { count: 3, average: 4.3 });
});

test("a review needs a rating, some words, a name and consent to publish", () => {
  const ok = { rating: 4, body: "A really lovely guide and a great day out.", displayName: "Ann", consent: true };
  assert.ok(reviewSchema.safeParse(ok).success);
  const msg = (over) => reviewSchema.safeParse({ ...ok, ...over }).error?.issues[0]?.message;
  assert.match(msg({ rating: 0 }), /star rating/);
  assert.match(msg({ body: "ok" }), /20 characters/);
  assert.match(msg({ displayName: "" }), /name/);
  assert.match(msg({ consent: false }), /publish/);
  assert.match(msg({ media: Array(7).fill("x") }), /at most 6/);
});
