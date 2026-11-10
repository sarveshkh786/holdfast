// PayPal REST client for the authorize -> (partial) capture / void lifecycle.
// Uses the sandbox by default. If no credentials are configured, runs in SIMULATED
// mode so the UI and agent can still be demoed; every response is tagged `simulated`.
import crypto from 'node:crypto';

const BASE = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

export const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
export const SIMULATED = !(CLIENT_ID && SECRET);
export const CURRENCY = process.env.CURRENCY || 'USD';

let tokenCache = { token: null, exp: 0 };

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  tokenCache = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return tokenCache.token;
}

async function call(method, path, body, idempotencyKey) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(idempotencyKey ? { 'PayPal-Request-Id': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`PayPal ${method} ${path} -> ${res.status}: ${json.message || text}`);
    err.details = json;
    throw err;
  }
  return json;
}

const money = (v) => ({ currency_code: CURRENCY, value: Number(v).toFixed(2) });

// ---------- simulated backend (no credentials) ----------
const sim = { orders: new Map(), auths: new Map() };
const simId = (p) => `${p}-SIM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

// ---------- public API ----------

/** Create an order with intent AUTHORIZE. Buyer approves it in the PayPal button. */
export async function createHoldOrder({ bookingId, amount, description }) {
  if (SIMULATED) {
    const id = simId('ORDER');
    sim.orders.set(id, { id, amount, status: 'CREATED', bookingId });
    return { id, status: 'CREATED', simulated: true };
  }
  const order = await call('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{
      reference_id: bookingId,
      custom_id: bookingId,
      description: description.slice(0, 127),
      amount: money(amount),
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'HoldFast',
          user_action: 'CONTINUE',
          shipping_preference: 'NO_SHIPPING',
        },
      },
    },
  }, `create-${bookingId}-${amount}`);
  return { id: order.id, status: order.status };
}

/** After buyer approval: place the authorization hold. */
export async function authorizeOrder(orderId) {
  if (SIMULATED) {
    const o = sim.orders.get(orderId);
    if (!o) throw new Error('Unknown simulated order');
    const id = simId('AUTH');
    const expiration_time = new Date(Date.now() + 29 * 864e5).toISOString();
    sim.auths.set(id, { id, amount: o.amount, captured: 0, status: 'CREATED' });
    o.status = 'COMPLETED';
    return { authorizationId: id, status: 'CREATED', expiration_time, simulated: true };
  }
  const res = await call('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
  const auth = res.purchase_units[0].payments.authorizations[0];
  return { authorizationId: auth.id, status: auth.status, expiration_time: auth.expiration_time };
}

/** Capture part (or all) of the hold. final=true releases any remainder. */
const isSeed = (id) => String(id).startsWith('AUTH-SEED');

export async function captureHold(authorizationId, amount, { note, final = true } = {}) {
  if (isSeed(authorizationId)) return { captureId: `CAP-SEED-${crypto.randomBytes(3).toString('hex').toUpperCase()} (demo seed)`, status: 'COMPLETED', amount, simulated: true };
  if (SIMULATED) {
    const a = sim.auths.get(authorizationId);
    if (!a) throw new Error('Unknown simulated authorization');
    if (amount > a.amount - a.captured + 1e-9) throw new Error('Capture exceeds held amount');
    a.captured += amount;
    a.status = final ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
    return { captureId: simId('CAP'), status: 'COMPLETED', amount, simulated: true };
  }
  const res = await call('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
    amount: money(amount),
    final_capture: final,
    note_to_payer: (note || 'Late-cancellation / no-show fee').slice(0, 255),
  }, `cap-${authorizationId}-${amount}`);
  return { captureId: res.id, status: res.status, amount };
}

/** Release the hold entirely. Client pays nothing. */
export async function voidHold(authorizationId) {
  if (SIMULATED || isSeed(authorizationId)) {
    const a = sim.auths.get(authorizationId);
    if (a) a.status = 'VOIDED';
    return { status: 'VOIDED', simulated: true };
  }
  await call('POST', `/v2/payments/authorizations/${authorizationId}/void`, null, `void-${authorizationId}`);
  return { status: 'VOIDED' };
}

/** Holds have a 3-day honor period; reauthorize for appointments further out. */
export async function reauthorizeHold(authorizationId, amount) {
  if (SIMULATED) return { authorizationId, status: 'CREATED', simulated: true };
  const res = await call('POST', `/v2/payments/authorizations/${authorizationId}/reauthorize`, { amount: money(amount) });
  return { authorizationId: res.id, status: res.status };
}

/** Verify a webhook really came from PayPal. */
export async function verifyWebhook(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (SIMULATED || !webhookId) return { verified: false, reason: 'no webhook id configured' };
  const res = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event,
  });
  return { verified: res.verification_status === 'SUCCESS' };
}
