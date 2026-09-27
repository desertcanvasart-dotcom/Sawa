// The traveler details a catalog booking needs under catalogue_v2 (model
// phase 3): every traveler's name, a pickup point, nationality where the
// product needs it, and an answer on health or safety needs, with an explicit
// "none". The phone number stays in each form's own phone field.
//
// Used by the tour page, the booking widget, the agency booking forms and the
// private booking-details link. The server enforces the same rule.
import React, { useEffect } from "react";

export const emptyTravelerDetails = () => ({ names: [""], pickupPoint: "", nationality: "", safetyNeeds: "", safetyNone: false });

// The body fields the booking APIs read.
export function travelerDetailsBody(d) {
  return {
    travelerNames: (d.names || []).map((n) => n.trim()).filter(Boolean),
    pickupPoint: d.pickupPoint.trim(),
    nationality: d.nationality.trim(),
    safetyNeeds: d.safetyNone ? "" : d.safetyNeeds.trim(),
    safetyNone: !!d.safetyNone,
  };
}

// What's still missing, in words, or "" when complete.
export function travelerDetailsError(d, seats, { needsNationality = false, phone = "x" } = {}) {
  const n = Math.max(1, Number(seats) || 1);
  const names = (d.names || []).slice(0, n).map((x) => x.trim());
  if (names.filter(Boolean).length < n) return n === 1 ? "Enter the traveler's name." : `Enter all ${n} travelers' names.`;
  if (!String(phone || "").trim()) return "Enter a phone number.";
  if (!d.pickupPoint.trim()) return "Enter the pickup point (hotel name and area).";
  if (needsNationality && !d.nationality.trim()) return "Enter the travelers' nationality: this tour's site tickets need it.";
  if (!d.safetyNone && !d.safetyNeeds.trim()) return "Tell us about any health or safety needs, or tick \"No health or safety needs\".";
  return "";
}

export function TravelerDetailsFields({ value, onChange, seats, needsNationality = false, pickupHint = "", className = "bk-field", leadName = "" }) {
  const n = Math.max(1, Number(seats) || 1);
  // Keep one name box per seat; the first defaults to the lead traveler.
  useEffect(() => {
    const names = [...(value.names || [])];
    if (names.length === n) return;
    while (names.length < n) names.push("");
    onChange({ ...value, names: names.slice(0, n) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const setName = (i) => (e) => {
    const names = [...value.names];
    names[i] = e.target.value;
    onChange({ ...value, names });
  };
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <label className={className} key={i}>
          <span>{n === 1 ? "Traveler's full name" : i === 0 ? "Traveler 1 (lead), full name" : `Traveler ${i + 1}, full name`}</span>
          <input value={value.names?.[i] || ""} onChange={setName(i)} required aria-required="true" maxLength={120}
            placeholder={i === 0 && leadName ? leadName : "As on their passport"} autoComplete={i === 0 ? "name" : "off"} />
        </label>
      ))}
      <label className={className}>
        <span>Pickup point</span>
        <input value={value.pickupPoint} onChange={set("pickupPoint")} required aria-required="true" maxLength={200} placeholder={pickupHint || "Hotel name and area"} />
      </label>
      {needsNationality && (
        <label className={className}>
          <span>Nationality <i className="opt">(site tickets need it)</i></span>
          <input value={value.nationality} onChange={set("nationality")} required aria-required="true" maxLength={80} placeholder="e.g. Canadian" autoComplete="country-name" />
        </label>
      )}
      <label className={className}>
        <span>Health or safety needs</span>
        <input value={value.safetyNone ? "" : value.safetyNeeds} onChange={set("safetyNeeds")} disabled={value.safetyNone} maxLength={1000}
          placeholder="e.g. uses a wheelchair, severe nut allergy" required={!value.safetyNone} aria-required={!value.safetyNone} />
      </label>
      <label className="bk-check" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={!!value.safetyNone} onChange={(e) => onChange({ ...value, safetyNone: e.target.checked, safetyNeeds: e.target.checked ? "" : value.safetyNeeds })} />
        <span>No health or safety needs</span>
      </label>
    </>
  );
}
