// Shared by the API and the page's inline data so React receives the same shape.
export const mapPost = (b) => ({
  id: b.id, slug: b.slug, title: b.title, excerpt: b.excerpt || "", coverImage: b.cover_image || "",
  coverAlt: b.cover_alt || "", coverCaption: b.cover_caption || "",
  bodyHtml: b.body_html || "", author: b.author || "", authorCredentials: b.author_credentials || "",
  tags: b.tags || [], status: b.status || "draft",
  publishedAt: b.published_at instanceof Date ? b.published_at.toISOString() : b.published_at,
  metaTitle: b.meta_title || "", metaDescription: b.meta_description || "", keywords: b.keywords || [],
  canonicalUrl: b.canonical_url || "", ogImage: b.og_image || "", noindex: b.noindex === true,
  tldr: b.tldr || "", keyTakeaways: b.key_takeaways || [], faq: b.faq || [],
  geoRegion: b.geo_region || "", geoPlace: b.geo_place || "", geoLat: b.geo_lat || "", geoLng: b.geo_lng || "",
  localKeywords: b.local_keywords || [],
  updatedAt: b.updated_at instanceof Date ? b.updated_at.toISOString() : b.updated_at,
});
