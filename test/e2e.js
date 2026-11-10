// End-to-end test of the full money lifecycle against a running server (simulated or sandbox).
// Usage: npm test   (spawns its own server on port 3999 with a temp data file)
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 3999;
const base = `http://localhost:${PORT}`;
const env = { ...process.env, PORT, DATA_FILE: path.join(os.tmpdir(), `holdfast-test-${Date.now()}.json`), ANTHROPIC_API_KEY: process.env.TEST_WITH_AI ? process.env.ANTHROPIC_API_KEY : '' };
if (!process.env.TEST_WITH_SANDBOX) { env.PAYPAL_CLIENT_ID = ''; env.PAYPAL_CLIENT_SECRET = ''; }
const srv = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => srv.stdout.on('data', (d) => { process.stdout.write('[server] ' + d); if (String(d).includes('HoldFast on')) ok(); }));

const j = async (url, body) => {
  const r = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
};
const step = (s) => console.log('\n✔', s);

try {
  // 1. Pick a free slot in the next hours today/tomorrow (within 24h => late-cancel rules apply)
  const today = new Date().toLocaleDateString('en-CA');
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA');
  let state = await j('/api/state');
  assert.ok(state.services.length >= 3);
  step('seeded state loaded');

  // 2. Client chats (offline agent) and books
  const chat1 = await j('/api/chat', { sessionId: 't1', clientName: 'Nina Test', message: 'Blow-dry tomorrow at 9am' });
  console.log('  agent:', chat1.reply);
  const chat2 = await j('/api/chat', { sessionId: 't1', clientName: 'Nina Test', message: 'yes book it' });
  console.log('  agent:', chat2.reply);
  const act = chat2.actions.find((a) => a.type === 'approve_hold');
  assert.ok(act, 'agent produced an approve_hold action');
  step(`agent created PayPal AUTHORIZE order ${act.orderId} for $${act.amount}`);

  // 3. Waitlister for same day
  await j('/api/chat', { sessionId: 't2', clientName: 'Omar Wait', message: 'blow-dry tomorrow at 9am' });
  // Directly join waitlist (the slot is taken)
  const wl = await j('/api/chat', { sessionId: 't2', clientName: 'Omar Wait', message: 'put me on the waitlist for blow-dry' });
  console.log('  agent:', wl.reply);

  // 4. Client approves hold in PayPal
  const held = await j(`/api/bookings/${act.bookingId}/approve`, { orderId: act.orderId });
  assert.equal(held.status, 'HELD');
  step(`hold authorized: ${held.authorizationId}`);

  // 5. Owner flags a seeded booking as no-show, then confirms partial capture
  state = await j('/api/state');
  const sam = state.bookings.find((b) => b.clientName === 'Sam Lee' && b.status === 'HELD');
  const ns = await j('/api/owner/chat', { sessionId: 'o', message: "Sam didn't show up" });
  console.log('  ops agent:', ns.reply);
  state = await j('/api/state');
  assert.equal(state.bookings.find((b) => b.id === sam.id).status, 'NEEDS_REVIEW');
  step('no-show flagged; nothing charged yet (human in the loop)');
  const fee = Math.max(1, sam.risk.noShowFee - 2);
  const charged = await j(`/api/owner/bookings/${sam.id}/confirm-charge`, { amount: fee });
  assert.equal(charged.status, 'CHARGED');
  step(`owner confirmed: captured $${fee} of $${sam.risk.hold} hold, remainder released`);

  // 6. Nina cancels late (tomorrow 9am may be >24h away; we accept either rule path)
  const c = await j(`/api/bookings/${act.bookingId}/cancel`, {});
  console.log('  cancel:', c.message, '| refilled by:', c.refilledBy);
  state = await j('/api/state');
  const offer = state.bookings.find((b) => b.offer && b.clientName === 'Omar Wait');
  assert.ok(offer, 'waitlist offer auto-created');
  step(`slot auto-offered to waitlist: ${offer.clientName}, new order ${offer.orderId}`);
  const filled = await j(`/api/bookings/${offer.id}/approve`, { orderId: offer.orderId });
  assert.equal(filled.status, 'HELD');
  state = await j('/api/state');
  assert.equal(state.summary.slots_refilled, 1);
  step('waitlister approved; slot refilled');

  // 7. Attended -> void
  const meera = state.bookings.find((b) => b.clientName === 'Meera Iyer' && b.status === 'HELD');
  const att = await j(`/api/owner/bookings/${meera.id}/attended`, {});
  assert.equal(att.status, 'ATTENDED');
  step('attended: hold voided');

  console.log('\nSummary:', (await j('/api/state')).summary);
  console.log('\nALL TESTS PASSED');
} catch (e) {
  console.error('\nTEST FAILED:', e);
  process.exitCode = 1;
} finally {
  srv.kill();
}
