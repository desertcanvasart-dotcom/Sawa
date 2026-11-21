// Keeping the campaign with the booking (migration 071).
//
// The values arrive with the booking request: sent by sawa.tours from the link
// the visitor landed on, or read here from the address of the page a partner's
// widget sits on, so an agency's own campaign links are recorded too. See
// shared/campaign.js for the convention and the cleaning.
//
// Written after the booking exists, as its own UPDATE, the way 070 keeps the
// partner's page: attribution is a fact ABOUT a booking and must never be a
// reason one fails. Before 071 is applied the UPDATE fails with 42703; that is
// remembered and the app carries on exactly as it did.
import { pool } from "./db/index.js";
import { rethrowIfProgrammerError } from "./errors.js";
import { cleanCampaign, campaignFromUrl, CAMPAIGN_KEYS } from "../shared/campaign.js";

let has071 = null;

// Reduce a booking request to its clean campaign, in place: the request's own
// utm fields if it sent any, else whatever the widget's page address carries.
// Called BEFORE pageUrl is narrowed to the partner's registered site, because
// the campaign is read from the address and never kept as an address.
export function takeCampaign(input) {
  const campaign = cleanCampaign(input) || campaignFromUrl(input.pageUrl);
  for (const key of CAMPAIGN_KEYS) {
    if (campaign && campaign[key]) input[key] = campaign[key];
    else delete input[key];
  }
  return campaign;
}

export async function rememberCampaign(db, bookingCode, input) {
  const campaign = cleanCampaign(input);
  if (!bookingCode || !campaign || has071 === false) return false;
  try {
    const r = await (db || pool).query(
      "UPDATE pledges SET utm_source = $2, utm_medium = $3, utm_campaign = $4 WHERE UPPER(booking_code) = UPPER($1)",
      [String(bookingCode), campaign.utmSource || null, campaign.utmMedium || null, campaign.utmCampaign || null]);
    has071 = true;
    return r.rowCount > 0;
  } catch (e) {
    rethrowIfProgrammerError(e);
    if (e?.code === "42703") has071 = false;
    console.warn(`[campaign] not kept with ${bookingCode} — ${e.message}`);
    return false;
  }
}

// Test seam. Not called by the application.
export const forget071 = () => { has071 = null; };
