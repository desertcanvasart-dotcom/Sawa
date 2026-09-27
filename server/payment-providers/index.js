// Payment providers for pay at GoAhead (model phase 4). The booking logic
// (server/pay-at-goahead.js) talks only to this interface, so a provider with
// an API — Paymob, Kashier, Geidea (docs/phase4/payments-readiness.md,
// section 10) — is one new adapter here and nothing else.
//
// Every adapter has:
//
//   name
//   createPaymentRequest(c, { request, booking, amountEur, deadlineAt })
//       → { linkUrl, reference }
//     Ask the payer for `amountEur` (EUR) by `deadlineAt`. `reference` is what
//     matches the payment back to the booking (the booking code). `linkUrl` is
//     null when the link can't be made yet (a manual provider): the booking
//     logic then waits for ops to attach it, and the deadline runs from then.
//
//   recordPayment(c, { request, providerReference, by })
//       → { providerReference, paidAt }
//     The payment arrived. Manual today (ops mark it paid with the provider's
//     own reference); a webhook later, calling the same path.
//
//   refund(c, { refund, request, amountEur })
//       → { done: false } | { done: true, providerReference }
//     Return money. A manual provider opens an ops task and answers
//     { done: false }; ops then record the refund's reference.
//
// `c` is the caller's transaction, so a task and the state it serves commit
// together or not at all.
import { tabManual } from "./tab-manual.js";

const PROVIDERS = new Map([[tabManual.name, tabManual]]);

export const DEFAULT_PROVIDER = tabManual.name;

// The provider new requests use: PAYMENT_PROVIDER, else Tab by hand.
export function activeProvider(env = process.env) {
  const name = String(env.PAYMENT_PROVIDER || DEFAULT_PROVIDER).trim();
  const p = PROVIDERS.get(name);
  if (!p) throw new Error(`PAYMENT_PROVIDER "${name}" is not a known provider (${[...PROVIDERS.keys()].join(", ")}).`);
  return p;
}

// The provider that handled an existing request, whatever is active now.
export function providerFor(name) {
  const p = PROVIDERS.get(name);
  if (!p) throw new Error(`Unknown payment provider "${name}".`);
  return p;
}

export const providerNames = () => [...PROVIDERS.keys()];
