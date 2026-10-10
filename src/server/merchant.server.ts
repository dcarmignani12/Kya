import { randomBytes } from "node:crypto";
import { HOTELS, buildOffer, type LedgerEntryView, type Offer } from "~/lib/domain";
import { randomId } from "./crypto.server";
import { db, withTx } from "./db.server";
import { appendLedger, appendLedgerTx, emitLedger } from "./ledger.server";
import { EnforcementError, verifyAssertionForUse } from "./kya.server";

// Simulated merchant (hotel inventory), PSP and card network. Every money
// movement is gated on a freshly re-verified KYA assertion.

export async function searchHotels(params: { city: string; check_in: string; check_out: string; guests?: number }): Promise<Offer[]> {
  const city = params.city.trim().toLowerCase();
  const offers =
    city === "milan" || city === "milano"
      ? HOTELS.map((h) => buildOffer(h, params.check_in, params.check_out)).filter((o): o is Offer => o !== null)
      : [];
  await appendLedger({
    event_type: "merchant.offers.quoted",
    actor: "merchant",
    payload: { city: params.city, check_in: params.check_in, check_out: params.check_out, offers: offers.map((o) => ({ offer_id: o.offer_id, amount_cents: o.amount_cents })) },
  });
  return offers;
}

const code = (n: number) =>
  Array.from(randomBytes(n))
    .map((b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32])
    .join("");

async function blocked(stage: string, err: EnforcementError, ref: Record<string, unknown>) {
  await appendLedger({ event_type: `gateway.${stage}.blocked`, actor: "gateway", payload: { code: err.code, reason: err.message, ...ref } });
}

export interface PaymentResult {
  payment_id: string;
  booking_id: string;
  status: "payment_authorized";
  hotel: string;
  amount_cents: number;
  currency: string;
  psp_auth_code: string;
  network_ref: string;
}

export async function authorizePayment(assertionId: string, claimedOfferId?: string): Promise<PaymentResult> {
  let verified;
  try {
    verified = await verifyAssertionForUse(assertionId);
    if (claimedOfferId && claimedOfferId !== verified.claims.offer_id) {
      throw new EnforcementError("offer_mismatch", `assertion covers ${verified.claims.offer_id}, not ${claimedOfferId}`);
    }
  } catch (err) {
    if (err instanceof EnforcementError) await blocked("payment", err, { assertion_id: assertionId });
    throw err;
  }
  const { claims, offer } = verified;
  const emitted: LedgerEntryView[] = [];
  try {
    const result = await withTx(async (tx) => {
      const payment_id = randomId("pay");
      const booking_id = randomId("bkg", 6);
      const psp_auth_code = code(6);
      const network_ref = `NTW-${code(10)}`;
      // assertion_id is UNIQUE: an ALLOW assertion is spendable exactly once.
      await tx.query(
        `INSERT INTO kya_bookings (booking_id, payment_id, assertion_id, agent_id, principal_id, mandate_id, approval_id, offer_id, hotel_name, merchant_id,
                                   check_in, check_out, nights, amount_cents, currency, psp_auth_code, network_ref, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'payment_authorized')`,
        [
          booking_id, payment_id, claims.jti, claims.sub, claims.principal_id, claims.mandate_id, claims.approval_id, offer.offer_id, offer.hotel_name,
          offer.merchant_id, offer.check_in, offer.check_out, offer.nights, offer.amount_cents, offer.currency, psp_auth_code, network_ref,
        ],
      );
      emitted.push(
        await appendLedgerTx(tx, {
          event_type: "psp.payment.authorized",
          actor: "psp",
          agent_id: claims.sub,
          payload: { payment_id, assertion_id: claims.jti, amount_cents: offer.amount_cents, currency: offer.currency, merchant_id: offer.merchant_id, psp_auth_code },
        }),
      );
      emitted.push(
        await appendLedgerTx(tx, {
          event_type: "network.authorization.approved",
          actor: "network",
          agent_id: claims.sub,
          payload: { payment_id, network_ref, mcc: offer.mcc, merchant_country: offer.merchant_country, agentic_indicator: true, kya_assertion_id: claims.jti },
        }),
      );
      return { payment_id, booking_id, status: "payment_authorized" as const, hotel: offer.hotel_name, amount_cents: offer.amount_cents, currency: offer.currency, psp_auth_code, network_ref };
    });
    emitLedger(...emitted);
    return result;
  } catch (err: any) {
    if (err?.code === "23505") {
      const e = new EnforcementError("assertion_spent", `assertion ${assertionId} was already used for a payment`);
      await blocked("payment", e, { assertion_id: assertionId });
      throw e;
    }
    throw err;
  }
}

export async function confirmBooking(paymentId: string) {
  const res = await db().query("SELECT * FROM kya_bookings WHERE payment_id = $1", [paymentId]);
  const row = res.rows[0];
  if (!row) {
    const e = new EnforcementError("payment_unknown", `no authorized payment ${paymentId}`);
    await blocked("booking", e, { payment_id: paymentId });
    throw e;
  }
  if (row.status === "confirmed") {
    return { booking_id: row.booking_id, confirmation_code: row.confirmation_code, status: "confirmed", hotel: row.hotel_name, already_confirmed: true };
  }
  try {
    const { claims } = await verifyAssertionForUse(row.assertion_id);
    if (claims.sub !== row.agent_id || claims.amount_cents !== row.amount_cents || claims.offer_id !== row.offer_id) {
      throw new EnforcementError("binding_mismatch", "payment does not match the KYA assertion");
    }
  } catch (err) {
    if (err instanceof EnforcementError) await blocked("booking", err, { payment_id: paymentId, assertion_id: row.assertion_id });
    throw err;
  }
  const confirmation_code = `MIL-${code(6)}`;
  const emitted: LedgerEntryView[] = [];
  await withTx(async (tx) => {
    const upd = await tx.query(
      "UPDATE kya_bookings SET status = 'confirmed', confirmation_code = $2, confirmed_at = now() WHERE payment_id = $1 AND status = 'payment_authorized'",
      [paymentId, confirmation_code],
    );
    if (!upd.rowCount) throw new EnforcementError("booking_race", "booking state changed concurrently");
    emitted.push(
      await appendLedgerTx(tx, {
        event_type: "merchant.booking.confirmed",
        actor: "merchant",
        agent_id: row.agent_id,
        payload: { booking_id: row.booking_id, payment_id: paymentId, confirmation_code, hotel: row.hotel_name, check_in: row.check_in, check_out: row.check_out, amount_cents: row.amount_cents },
      }),
    );
  });
  emitLedger(...emitted);
  return {
    booking_id: row.booking_id,
    confirmation_code,
    status: "confirmed",
    hotel: row.hotel_name,
    check_in: row.check_in,
    check_out: row.check_out,
    amount_cents: row.amount_cents,
    currency: row.currency,
  };
}

export async function listBookings() {
  const res = await db().query("SELECT * FROM kya_bookings ORDER BY created_at DESC LIMIT 100");
  return res.rows.map((r) => ({
    ...r,
    created_at: new Date(r.created_at).toISOString(),
    confirmed_at: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
  }));
}

