import test from "node:test";
import assert from "node:assert/strict";
import { blogSchedule } from "../blog-publication.js";
import { blogReschedule, rescheduleBlogs } from "./reschedule-blogs-20261120.js";

test("55 future posts, no further November releases, at most 12 each month including Cairo DST", () => {
  assert.equal(blogReschedule.length, 55);
  assert.equal(blogReschedule[0].publishAt, "2026-12-01T09:00:00+02:00");
  const months = new Map();
  for (const post of blogReschedule) {
    const month = post.publishAt.slice(0, 7);
    months.set(month, (months.get(month) || 0) + 1);
    assert.equal(blogSchedule.find(p => p.slug === post.slug).publishAt, post.publishAt);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" }).format(new Date(post.publishAt)), "09:00");
  }
  for (const count of months.values()) assert.ok(count <= 12);
  assert.ok(blogReschedule.at(-1).publishAt.endsWith("+03:00"));
  assert.equal(blogSchedule[11].publishAt, "2026-11-19T09:00:00+02:00");
});

test("reschedule is once-only and updates only guarded future dates", async () => {
  let marked = false;
  let updates = 0;
  const client = { async query(sql, values) {
    if (sql.startsWith("SELECT 1")) return { rows: marked ? [{}] : [] };
    if (sql.startsWith("UPDATE")) {
      assert.match(sql, /published_at > now\(\)/);
      assert.match(sql, /published_at IN/);
      assert.doesNotMatch(sql, /body_html|updated_at|title=/);
      assert.equal(values[2], blogReschedule[updates++].slug);
      return { rows: [{ id: values[1] }] };
    }
    if (sql.startsWith("INSERT")) marked = true;
    return { rows: [] };
  } };
  await rescheduleBlogs(client);
  assert.equal(await rescheduleBlogs(client), "already applied");
  assert.equal(updates, 55);
});

test("a changed or already-published row aborts rather than being overwritten", async () => {
  const client = { async query(sql) {
    assert.doesNotMatch(sql, /^INSERT/);
    return { rows: [] };
  } };
  await assert.rejects(rescheduleBlogs(client), /changed since review/);
});
