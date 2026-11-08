import { readFileSync } from "node:fs";

export const blogSchedule = JSON.parse(readFileSync(new URL("../content/blog-schedule.json", import.meta.url), "utf8"));
const releases = new Map(blogSchedule.map(p => [p.slug, Date.parse(p.publishAt)]));

export function isBlogPublished(post, now = Date.now()) {
  return post.status === "published" && (!post.published_at || Date.parse(post.published_at) <= now);
}

export function stripBlogSources(html = "") {
  return html.replace(/<h([2-6])\b[^>]*>\s*Sources\s*<\/h\1>\s*(?:<p>[^<]*<\/p>\s*)?<(ul|ol)\b[^>]*>[\s\S]*?<\/\2>/gi, "");
}

// A link becomes clickable on the same request that its scheduled target goes live.
export function publicBlogHtml(html = "", now = Date.now()) {
  return stripBlogSources(html).replace(/<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (anchor, _quote, href, label) => {
      try {
        const url = new URL(href.replaceAll("&amp;", "&"), "https://sawa.tours");
        if (!["sawa.tours", "www.sawa.tours"].includes(url.hostname)) return anchor;
        const slug = decodeURIComponent(url.pathname.match(/^\/blog\/([^/]+)\/?$/)?.[1] || "");
        return releases.has(slug) && releases.get(slug) > now ? label : anchor;
      } catch { return anchor; }
    });
}

export const mergedBlogSlugs = {
  "5-days-in-egypt": "7-days-in-egypt-small-group",
  "aswan-to-luxor-by-road": "luxor-to-aswan",
};
