// ============================================================
// Single source of truth for brand facts used by all SEO / GEO
// outputs (JSON-LD, llms.txt, meta tags, sitemap).
// Lines marked TODO need real values from the brand stakeholder —
// edit them here and every schema/output updates automatically.
// ============================================================

export const BRAND = {
  name: "Sawa Tours",
  alternateName: "Sawa Shared Tours",
  url: "https://sawa.tours",
  logo: "https://sawa.tours/images/hero.jpg", // TODO: replace with a real square logo image (PNG, ~512px)
  positioning: "Shared departures, confirmed together.",
  description:
    "Sawa is a Cairo-based shared-tour platform. We pool small bookings from independent travellers onto the same date, so day tours and multi-day packages across Egypt are guaranteed to run — you hold a seat for free and only pay once your departure is confirmed (GoAhead).",
  foundingDate: "", // TODO e.g. "2024"
  founders: [], // TODO e.g. [{ name: "…", jobTitle: "Founder" }]
  email: "hello@sawa.tours",
  telephone: "+20 109 284 7613",
  whatsapp: "https://wa.me/201092847613",
  address: {
    streetAddress: "", // TODO
    addressLocality: "Cairo",
    addressRegion: "Cairo Governorate",
    postalCode: "", // TODO
    addressCountry: "EG",
  },
  sameAs: [], // TODO social profile URLs: Instagram, Facebook, TripAdvisor, etc.
  awards: [], // TODO e.g. ["…"]
  accreditations: [], // TODO e.g. ["Egyptian Tourism Authority licensed operator"]
  knowsAbout: [
    "Egypt day tours", "Shared group tours", "Cairo tours", "Giza Pyramids",
    "Grand Egyptian Museum", "Luxor tours", "Valley of the Kings", "Aswan tours",
    "Abu Simbel", "Philae Temple", "Nile temples", "Egyptology",
  ],
  areaServed: ["Cairo", "Giza", "Luxor", "Aswan", "Egypt"],
  priceRange: "$$", // TODO confirm tier
};

export const ORG_ID = `${BRAND.url}/#organization`;
export const SITE_ID = `${BRAND.url}/#website`;

// schema.org TravelAgency — the brand entity, referenced elsewhere by @id.
export function travelAgencySchema() {
  const s = {
    "@type": "TravelAgency",
    "@id": ORG_ID,
    name: BRAND.name,
    alternateName: BRAND.alternateName || undefined,
    url: BRAND.url,
    logo: BRAND.logo || undefined,
    image: BRAND.logo || undefined,
    description: BRAND.description,
    slogan: BRAND.positioning || undefined,
    email: BRAND.email || undefined,
    telephone: BRAND.telephone || undefined,
    priceRange: BRAND.priceRange || undefined,
    foundingDate: BRAND.foundingDate || undefined,
    address: {
      "@type": "PostalAddress",
      streetAddress: BRAND.address.streetAddress || undefined,
      addressLocality: BRAND.address.addressLocality || undefined,
      addressRegion: BRAND.address.addressRegion || undefined,
      postalCode: BRAND.address.postalCode || undefined,
      addressCountry: BRAND.address.addressCountry || undefined,
    },
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer service",
      email: BRAND.email || undefined,
      telephone: BRAND.telephone || undefined,
      areaServed: "EG",
      availableLanguage: ["en"],
    },
    areaServed: BRAND.areaServed.map((name) => ({ "@type": "Place", name })),
    knowsAbout: BRAND.knowsAbout,
  };
  if (BRAND.founders.length) s.founder = BRAND.founders.map((f) => ({ "@type": "Person", name: f.name, jobTitle: f.jobTitle || undefined }));
  if (BRAND.sameAs.length) s.sameAs = BRAND.sameAs;
  if (BRAND.awards.length) s.award = BRAND.awards;
  if (BRAND.accreditations.length) s.hasCredential = BRAND.accreditations;
  return s;
}

// schema.org WebSite — with a SearchAction so AI systems know how to query us.
export function websiteSchema() {
  return {
    "@type": "WebSite",
    "@id": SITE_ID,
    name: BRAND.name,
    url: BRAND.url,
    publisher: { "@id": ORG_ID },
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${BRAND.url}/tours?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}
