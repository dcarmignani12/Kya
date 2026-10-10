// Shared, client-safe domain data: the mandate, the simulated Milan hotel
// catalog and the stream event types. Nothing in here is a secret, and none of
// it is trusted at enforcement time from the client: the KYA verifier only
// trusts the mandate inside the principal-signed delegation credential, and
// prices are re-derived server-side from the offer id.

export const AGENT_ID = "agt_atlas_001";
export const AGENT_KEY_ID = "agt_atlas_001#key-1";
export const PRINCIPAL_ID = "prn_alex_morgan";
export const PRINCIPAL_NAME = "Alex Morgan";
export const KYA_ISSUER = "kya.agenttrip.demo";

export const EU_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
] as const;

export interface Mandate {
  mandate_id: string;
  principal_id: string;
  principal_name: string;
  agent_id: string;
  purpose: string;
  city: string;
  check_in: string; // YYYY-MM-DD
  check_out: string;
  currency: "EUR";
  max_total_cents: number;
  max_nightly_cents: number;
  autonomous_limit_cents: number;
  allowed_mccs: string[];
  allowed_merchant_countries: string[];
  valid_until: string; // ISO timestamp
}

export const MANDATE: Mandate = {
  mandate_id: "mdt_alex_milan_1115",
  principal_id: PRINCIPAL_ID,
  principal_name: PRINCIPAL_NAME,
  agent_id: AGENT_ID,
  purpose: "Hotel stay in Milan, 15–17 Nov 2026 (2 nights)",
  city: "Milan",
  check_in: "2026-11-15",
  check_out: "2026-11-17",
  currency: "EUR",
  max_total_cents: 80000,
  max_nightly_cents: 40000,
  autonomous_limit_cents: 70000,
  allowed_mccs: ["7011"],
  allowed_merchant_countries: [...EU_COUNTRIES],
  valid_until: "2026-11-15T00:00:00Z",
};

export interface Hotel {
  id: string;
  name: string;
  neighborhood: string;
  stars: number;
  rating: number;
  nightly_cents: number;
  amenities: string[];
  blurb: string;
  hue: number; // card artwork
  merchant: { id: string; legal_name: string; country: string; mcc: string; mcc_label: string };
}

export const HOTELS: Hotel[] = [
  {
    id: "brera-lumen",
    name: "Hotel Brera Lumen",
    neighborhood: "Brera",
    stars: 4,
    rating: 9.1,
    nightly_cents: 29000,
    amenities: ["Free cancellation", "Breakfast", "Wi-Fi"],
    blurb: "Quiet boutique rooms between the Pinacoteca and the Brera galleries.",
    hue: 38,
    merchant: { id: "mer_brera_lumen", legal_name: "Brera Lumen S.r.l.", country: "IT", mcc: "7011", mcc_label: "Hotels & lodging" },
  },
  {
    id: "navigli-canal-house",
    name: "Navigli Canal House",
    neighborhood: "Navigli",
    stars: 4,
    rating: 8.8,
    nightly_cents: 33000,
    amenities: ["Canal view", "Bar", "Wi-Fi"],
    blurb: "Restored 19th-century warehouse on the Naviglio Grande.",
    hue: 190,
    merchant: { id: "mer_navigli_ch", legal_name: "Navigli Ospitalità S.p.A.", country: "IT", mcc: "7011", mcc_label: "Hotels & lodging" },
  },
  {
    id: "duomo-grand-palazzo",
    name: "Duomo Grand Palazzo",
    neighborhood: "Centro Storico",
    stars: 5,
    rating: 9.4,
    nightly_cents: 37500,
    amenities: ["Duomo view", "Spa", "Breakfast"],
    blurb: "Five-star palazzo steps from the cathedral terraces.",
    hue: 280,
    merchant: { id: "mer_duomo_gp", legal_name: "Palazzo Duomo Hotels S.p.A.", country: "IT", mcc: "7011", mcc_label: "Hotels & lodging" },
  },
  {
    id: "porta-nuova-sky",
    name: "Porta Nuova Sky Suites",
    neighborhood: "Porta Nuova",
    stars: 5,
    rating: 9.6,
    nightly_cents: 45000,
    amenities: ["Skyline suites", "Rooftop pool", "Butler"],
    blurb: "Glass-tower suites above Piazza Gae Aulenti.",
    hue: 210,
    merchant: { id: "mer_pn_sky", legal_name: "PN Sky Hospitality S.r.l.", country: "IT", mcc: "7011", mcc_label: "Hotels & lodging" },
  },
  {
    id: "centrale-transit-inn",
    name: "Centrale Transit Inn",
    neighborhood: "Stazione Centrale",
    stars: 3,
    rating: 8.1,
    nightly_cents: 21000,
    amenities: ["Next to station", "24h desk"],
    blurb: "Budget rooms by Milano Centrale, sold through a Swiss reseller.",
    hue: 150,
    merchant: { id: "mer_lugano_rooms", legal_name: "Lugano Rooms Reseller SA", country: "CH", mcc: "7011", mcc_label: "Hotels & lodging" },
  },
  {
    id: "isola-residences",
    name: "Isola Residences Club",
    neighborhood: "Isola",
    stars: 4,
    rating: 8.6,
    nightly_cents: 18000,
    amenities: ["Kitchenette", "Members lounge"],
    blurb: "Serviced apartments sold as timeshare club points.",
    hue: 12,
    merchant: { id: "mer_isola_club", legal_name: "Isola Vacation Club S.r.l.", country: "IT", mcc: "7012", mcc_label: "Timeshares" },
  },
];

export interface Offer {
  offer_id: string;
  hotel_id: string;
  hotel_name: string;
  city: string;
  merchant_id: string;
  merchant_name: string;
  merchant_country: string;
  mcc: string;
  check_in: string;
  check_out: string;
  nights: number;
  nightly_cents: number;
  amount_cents: number;
  currency: "EUR";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

export function makeOfferId(hotelId: string, checkIn: string, checkOut: string): string {
  return `off_${hotelId}_${checkIn.replaceAll("-", "")}_${checkOut.replaceAll("-", "")}`;
}

export function buildOffer(hotel: Hotel, checkIn: string, checkOut: string): Offer | null {
  if (!DATE_RE.test(checkIn) || !DATE_RE.test(checkOut)) return null;
  const nights = nightsBetween(checkIn, checkOut);
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) return null;
  return {
    offer_id: makeOfferId(hotel.id, checkIn, checkOut),
    hotel_id: hotel.id,
    hotel_name: hotel.name,
    city: "Milan",
    merchant_id: hotel.merchant.id,
    merchant_name: hotel.merchant.legal_name,
    merchant_country: hotel.merchant.country,
    mcc: hotel.merchant.mcc,
    check_in: checkIn,
    check_out: checkOut,
    nights,
    nightly_cents: hotel.nightly_cents,
    amount_cents: hotel.nightly_cents * nights,
    currency: "EUR",
  };
}

/** Re-derive an offer purely from its id (the merchant's authoritative price list). */
export function resolveOffer(offerId: string): Offer | null {
  const m = /^off_([a-z0-9-]+)_(\d{8})_(\d{8})$/.exec(offerId);
  if (!m) return null;
  const hotel = HOTELS.find((h) => h.id === m[1]);
  if (!hotel) return null;
  const toDate = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return buildOffer(hotel, toDate(m[2]), toDate(m[3]));
}

export type PolicyOutcome = "ALLOW" | "STEP_UP_APPROVAL" | "DENY";

export interface LimitCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Pure mandate-limit evaluation. The KYA verifier calls this with the mandate
 * taken from the verified delegation credential; the marketplace calls it with
 * MANDATE only to render a preview badge.
 */
export function evaluateMandateLimits(offer: Offer, mandate: Mandate): { outcome: PolicyOutcome; checks: LimitCheck[] } {
  const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
  const checks: LimitCheck[] = [
    {
      name: "currency",
      ok: offer.currency === mandate.currency,
      detail: `${offer.currency} (mandate: ${mandate.currency})`,
    },
    {
      name: "mcc",
      ok: mandate.allowed_mccs.includes(offer.mcc),
      detail: `MCC ${offer.mcc} (allowed: ${mandate.allowed_mccs.join(", ")})`,
    },
    {
      name: "merchant_region",
      ok: mandate.allowed_merchant_countries.includes(offer.merchant_country),
      detail: `merchant of record in ${offer.merchant_country} (EU only)`,
    },
    {
      name: "city",
      ok: offer.city === mandate.city,
      detail: `${offer.city} (mandate: ${mandate.city})`,
    },
    {
      name: "dates",
      ok: offer.check_in === mandate.check_in && offer.check_out === mandate.check_out,
      detail: `${offer.check_in} → ${offer.check_out} (mandate: ${mandate.check_in} → ${mandate.check_out})`,
    },
    {
      name: "nightly_limit",
      ok: offer.nightly_cents <= mandate.max_nightly_cents,
      detail: `${eur(offer.nightly_cents)}/night (max ${eur(mandate.max_nightly_cents)})`,
    },
    {
      name: "total_limit",
      ok: offer.amount_cents <= mandate.max_total_cents,
      detail: `${eur(offer.amount_cents)} total (max ${eur(mandate.max_total_cents)})`,
    },
  ];
  const withinAutonomy = offer.amount_cents <= mandate.autonomous_limit_cents;
  checks.push({
    name: "autonomous_limit",
    ok: withinAutonomy,
    detail: withinAutonomy
      ? `${eur(offer.amount_cents)} ≤ autonomous limit ${eur(mandate.autonomous_limit_cents)}`
      : `${eur(offer.amount_cents)} > autonomous limit ${eur(mandate.autonomous_limit_cents)} — principal step-up required`,
  });
  const hardFail = checks.slice(0, -1).some((c) => !c.ok);
  return { outcome: hardFail ? "DENY" : withinAutonomy ? "ALLOW" : "STEP_UP_APPROVAL", checks };
}

export function formatEur(cents: number): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
}

// ---------------------------------------------------------------------------
// Stream events (NDJSON lines from POST /api/agent)

export type Actor = "principal" | "agent" | "gateway" | "kya" | "merchant" | "psp" | "network" | "audit";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface LedgerEntryView {
  seq: number;
  ts: string;
  event_type: string;
  actor: Actor;
  agent_id: string | null;
  run_id: string | null;
  payload: { [key: string]: Json };
  prev_hash: string;
  hash: string;
}

export type AgentEvent =
  | { type: "run"; run_id: string; model: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: unknown; is_error: boolean }
  | { type: "ledger"; entry: LedgerEntryView }
  | { type: "error"; message: string }
  | { type: "done"; stop_reason: string | null; messages: unknown[] };
