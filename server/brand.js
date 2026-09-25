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
  // Square, transparent PNG. Google's logo guidance wants the mark itself, not
  // a photograph — this used to point at hero.jpg, which made the brand's
  // "logo" a picture of the pyramids.
  logo: "https://sawa.tours/images/logo-sawa.png",
  // Distinct from the logo on purpose: schema.org `image` is the picture that
  // represents the business in a result card, where a photograph outperforms a
  // wordmark on white.
  image: "https://sawa.tours/images/hero.jpg",
  positioning: "Shared departures, confirmed together.",
  // This said day tours and packages "are guaranteed to run", which is the
  // claim the whole sweep exists to remove — and it was the worst-placed copy
  // of it on the site. One string, three outputs: the /about meta description,
  // the JSON-LD Organization description, and llms.txt. Google and the AI
  // engines were reading it directly.
  description:
    "Sawa is a Cairo-based shared-tour platform. We pool small bookings from independent travellers onto the same date, so day tours and multi-day packages across Egypt reach the numbers they need to run — you hold a seat for free and only pay once your departure is confirmed (GoAhead).",
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
  // Shown to search engines as hasCredential, and printed in every footer.
  // DIR-19 / DDDD2 — the operating entity. Rendered EXACTLY as supplied: no
  // legal-form suffix was given, so none is added. Inventing "LLC" or "S.A.E."
  // would be a claim about a company's registered form that nobody made.
  legalName: "Online Era",
  registrationNumber: "148500",

  // ⚠️ ETAA 2179 IS NOT ONLINE ERA'S. It is Capital Travel Service's travel-agency
  // registration, and it used to sit in the footer because CTS was presented as
  // the operator of the platform. Under DIR-19.3 CTS becomes an OPERATOR RECORD
  // — a founding partner — and the number goes with it. Presenting one company's
  // licence as another's is the class this project removes, and
  // server/entity-disclosure.test.js fails the build if "ETAA 2179" reappears.
  //
  // The list was empty because the operating entity's OWN credentials had never
  // been supplied. The client confirmed on 14 August 2026 that it holds both,
  // which is also what the two marks now in the homepage hero assert — so this
  // exists to make the machine-readable claim match the visible one. A logo a
  // human can see and a graph that says nothing is a claim with no evidence
  // behind it in the only place a search engine looks.
  //
  // NO NUMBERS, DELIBERATELY. A licence or membership number is exactly the kind
  // of specific, checkable fact that must come from the holder; none was given,
  // and the last time a number sat here it belonged to a different company.
  // Naming the recognising bodies is true and complete on its own. Add
  // `identifier` to either entry the day the real numbers arrive.
  accreditations: [
    {
      "@type": "EducationalOccupationalCredential",
      name: "Egyptian tourism operating licence",
      credentialCategory: "license",
      recognizedBy: {
        "@type": "GovernmentOrganization",
        name: "Ministry of Tourism and Antiquities",
        alternateName: "MOTA",
        address: { "@type": "PostalAddress", addressCountry: "EG" },
      },
    },
    {
      "@type": "EducationalOccupationalCredential",
      name: "Egyptian Travel Agents Association membership",
      credentialCategory: "membership",
      recognizedBy: {
        "@type": "Organization",
        name: "Egyptian Travel Agents Association",
        alternateName: "ETAA",
        address: { "@type": "PostalAddress", addressCountry: "EG" },
      },
    },
  ],
  knowsAbout: [
    "Egypt day tours", "Shared group tours", "Cairo tours", "Giza Pyramids",
    "Grand Egyptian Museum", "Luxor tours", "Valley of the Kings", "Aswan tours",
    "Abu Simbel", "Philae Temple", "Nile temples", "Egyptology",
  ],
  areaServed: ["Cairo", "Giza", "Luxor", "Aswan", "Egypt"],
  // schema.org's coarse price tier, not an amount — but it is rendered as a
  // currency glyph and a visitor can see it in a rich result, so it carries the
  // site's currency like everything else. TODO confirm tier.
  priceRange: "€€",
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
    image: BRAND.image || BRAND.logo || undefined,
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
    legalName: BRAND.legalName || undefined,
    // The registration number as a typed identifier rather than free text, so a
    // consumer can read it without parsing a sentence. `name` says only
    // "Registration" — the registry it belongs to was not supplied and is not
    // guessed.
    identifier: BRAND.registrationNumber
      ? { "@type": "PropertyValue", name: "Registration", value: BRAND.registrationNumber }
      : undefined,
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

// schema.org WebSite. SearchAction was deliberately removed: Google's sitelinks
// search box is retired, while crawlers were requesting its URL template
// literally (`?q={search_term_string}`) and creating duplicate crawl URLs.
export function websiteSchema() {
  return {
    "@type": "WebSite",
    "@id": SITE_ID,
    name: BRAND.name,
    url: BRAND.url,
    publisher: { "@id": ORG_ID },
  };
}

// Who runs a date booked by travellers directly, with no agency: the operator
// record of this name (matched against agencies.name). U01, decided by the
// client on 25 Sep 2026 — see operatorForDeparture() in domain.js for the rule.
// Overridable per environment; an unmatched name simply names nobody.
export const DIRECT_BOOKINGS_OPERATOR = process.env.DIRECT_BOOKINGS_OPERATOR || "Capital Travel Service";
