// Convert snake_case DB rows into the camelCase JSON shape the existing
// frontend already expects, so the API response stays byte-for-byte compatible
// and no frontend changes are needed in Phase 1.

// departures.date / start_date / end_date and pledges.balance_due_date are all
// plain DATE columns — a calendar day, no instant and no zone. `pg` hands them
// back as a Date at LOCAL midnight, so reading them with toISOString() (which is
// UTC) moved every date one day earlier on any host east of UTC: a departure
// stored as 2026-10-07 was published, priced and expired as 2026-10-06 on a
// Cairo machine. Production runs UTC, where the two happen to agree, which is
// why this stayed hidden. Read the local calendar fields instead — same fix as
// balanceDueDate in domain.js, from the other direction.
export function isoDate(value) {
  if (!value) return value ?? null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).slice(0, 10);
}

function num(value) {
  return value === null || value === undefined ? value : Number(value);
}

export function mapCity(r) {
  return { id: r.id, name: r.name, region: r.region, status: r.status };
}

export function mapAgency(r) {
  return {
    id: r.id,
    name: r.name,
    contactName: r.contact_name,
    phone: r.phone,
    status: r.status,
    // The operator record (025/029/035/036). ADMIN-FACING: this mapper feeds
    // /api/admin/agencies, which is behind requireAdmin, and the public payload
    // never uses it — see publicOperator() in domain.js, which is the whitelist
    // that decides what a traveller may see.
    relationship: r.relationship || null,
    tourismLicenseNo: r.tourism_license_no || null,
    tourismLicenseYear: r.tourism_license_year ?? null,
    etaaRegistrationNo: r.etaa_registration_no || null,
    insuranceInsurer: r.insurance_insurer || null,
    insurancePolicyNo: r.insurance_policy_no || null,
    insuranceExpires: r.insurance_expires || null,
    trackRecord: r.track_record || null,
    verificationState: r.verification_state || null,
    verificationEvidence: r.verification_evidence || null,
    verifiedAt: r.verified_at || null,
  };
}

export function mapProduct(r) {
  const out = {
    id: r.id,
    type: r.type,
    title: r.title,
    city: r.city,
    duration: r.duration,
    defaultTime: r.default_time,
    guide: r.guide,
    vehicle: r.vehicle,
    minSeats: num(r.min_seats),
    maxSeats: num(r.max_seats),
    baseCost: num(r.base_cost),
    publishedRate: num(r.published_rate),
    breakPrice: num(r.break_price),
    quality: num(r.quality),
    depositPercent: num(r.deposit_percent),
    description: r.description,
    operatingDays: Array.isArray(r.operating_days) ? r.operating_days : [],
    // NULL is preserved rather than defaulted here: "nobody set one" and
    // "someone chose 90" are different facts, and shared/request-window.js
    // is the only place that turns the first into a number.
    requestMinLeadDays: r.request_min_lead_days ?? null,
    requestMaxHorizonDays: r.request_max_horizon_days ?? null,
    included: r.included ?? [],
    notIncluded: r.not_included ?? [],
    active: r.active !== false,
    // Approval workflow
    status: r.status || "approved",
    agencyId: r.agency_id || null,
    submittedAt: r.submitted_at || null,
    reviewedAt: r.reviewed_at || null,
    rejectionReason: r.rejection_reason || "",
    // Phase A — rich content
    overviewHtml: r.overview_html ?? "",
    policiesHtml: r.policies_html ?? "",
    whatToBring: r.what_to_bring ?? [],
    meetingPoint: r.meeting_point ?? "",
    pickupNote: r.pickup_note ?? "",
    meetingPoints: r.meeting_points ?? [],
    bookingCutoffHours: r.booking_cutoff_hours == null ? 24 : num(r.booking_cutoff_hours),
    // How the operator expressed the cutoff (038): null reads as hours. The
    // hours above stay the enforced value either way.
    bookingCutoffUnit: r.booking_cutoff_unit || null,
    // NULL stays null: domain.js resolves it to the type default, so the policy
    // has exactly one home rather than being frozen into every row.
    confirmDeadlineDays: r.confirm_deadline_days == null ? null : num(r.confirm_deadline_days),
    // NULL means "use the published/break interpolation" — see livePriceFor.
    priceTiers: Array.isArray(r.price_tiers) && r.price_tiers.length ? r.price_tiers : null,
    images: r.images ?? [],
    itinerary: r.itinerary ?? [],
  };
  if (r.type === "package") {
    out.cities = r.cities ?? [];
    out.nights = num(r.nights);
    out.accommodationTiers = r.accommodation_tiers ?? [];
  }
  return out;
}

export function mapPledge(r) {
  const out = {
    id: r.id,
    agencyId: r.agency_id,
    agency: r.agency,
    seats: num(r.seats),
    customers: r.customers,
    status: r.status || "confirmed",
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
  if (r.paid !== null && r.paid !== undefined) out.paid = r.paid === true;
  if (r.customer_email) out.customerEmail = r.customer_email;
  if (r.customer_phone) out.customerPhone = r.customer_phone;
  if (r.traveller_names && r.traveller_names.length) out.travellerNames = r.traveller_names;
  // Optional computed/booking fields — only include when present.
  if (r.price_per_person !== null && r.price_per_person !== undefined) out.pricePerPerson = num(r.price_per_person);
  if (r.booking_total !== null && r.booking_total !== undefined) out.bookingTotal = num(r.booking_total);
  if (r.deposit_percent !== null && r.deposit_percent !== undefined) out.depositPercent = num(r.deposit_percent);
  if (r.deposit_due !== null && r.deposit_due !== undefined) out.depositDue = num(r.deposit_due);
  if (r.balance_due !== null && r.balance_due !== undefined) out.balanceDue = num(r.balance_due);
  if (r.balance_due_date) out.balanceDueDate = isoDate(r.balance_due_date);
  if (r.source) out.source = r.source;
  if (r.booking_code) out.bookingCode = r.booking_code;
  // The partner whose widget the booking came through — it decides which
  // agency the passenger counts for when the operator is worked out (U01).
  if (r.ref_code) out.refCode = r.ref_code;
  if (r.rooming_type) out.roomingType = r.rooming_type;
  if (r.accommodation_tier) out.accommodationTier = r.accommodation_tier;
  if (r.accommodation_tier_name) out.accommodationTierName = r.accommodation_tier_name;
  return out;
}

export function mapDeparture(r, pledges = []) {
  const out = {
    id: num(r.id),
    type: r.type,
    tourProductId: r.tour_product_id,
    route: r.route,
    date: isoDate(r.date),
    time: r.time,
    city: r.city,
    guide: r.guide,
    vehicle: r.vehicle,
    minSeats: num(r.min_seats),
    maxSeats: num(r.max_seats),
    baseCost: num(r.base_cost),
    publishedRate: num(r.published_rate),
    breakPrice: num(r.break_price),
    quality: num(r.quality),
    status: r.status,
    notes: r.notes,
    depositPercent: num(r.deposit_percent),
    pledges: pledges.map(mapPledge),
  };
  if (r.type === "package") {
    out.startDate = isoDate(r.start_date);
    out.endDate = isoDate(r.end_date);
    out.nights = num(r.nights);
    out.cities = r.cities ?? [];
  }
  return out;
}
