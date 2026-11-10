// Verifies your sandbox credentials and the server-side half of the hold lifecycle.
// Run: npm run paypal:smoke
// (Authorizing requires buyer approval, so this creates an order and prints the approval link.
//  Open it, log in with your sandbox *personal* account, approve, then re-run with ORDER_ID=... to
//  authorize, partially capture and confirm the remainder is released.)
import 'dotenv/config';
import * as paypal from '../src/paypal.js';

if (paypal.SIMULATED) { console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.'); process.exit(1); }

const orderId = process.env.ORDER_ID;
if (!orderId) {
  const o = await paypal.createHoldOrder({ bookingId: `smoke-${Date.now()}`, amount: 20, description: 'HoldFast smoke test' });
  console.log('Created AUTHORIZE order:', o.id);
  console.log(`Approve it here (sandbox buyer): https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`);
  console.log(`Then run: ORDER_ID=${o.id} npm run paypal:smoke`);
} else {
  const a = await paypal.authorizeOrder(orderId);
  console.log('Authorized:', a);
  const c = await paypal.captureHold(a.authorizationId, 7, { note: 'Smoke test partial capture', final: true });
  console.log('Captured $7 of $20 (final_capture releases the other $13):', c);
}
