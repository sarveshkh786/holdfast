import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import * as store from './store.js';
import * as paypal from './paypal.js';
import * as bk from './bookings.js';
import { chat, summary, AI_MODE } from './agent.js';
import { seed } from './seed.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve('public')));
app.use('/vendor/ag-grid', express.static(path.resolve('node_modules/ag-grid-community/dist')));
app.get('/favicon.ico', (_, res) => res.status(204).end());

if (!store.get().services.length) seed();

// ---- live updates (Server-Sent Events) for the owner dashboard ----
const listeners = new Set();
bk.onChange(() => { for (const res of listeners) res.write(`data: ${Date.now()}\n\n`); });
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('data: hello\n\n');
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
});

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { console.error(e.message); res.status(e.userFacing ? 400 : 500).json({ error: e.message }); }
};

// ---- config for the frontend ----
app.get('/api/config', wrap(() => ({
  business: store.get().business,
  paypalClientId: paypal.CLIENT_ID,
  simulated: paypal.SIMULATED,
  currency: paypal.CURRENCY,
  aiMode: AI_MODE,
})));

app.get('/api/state', wrap(() => {
  const db = store.get();
  return { business: db.business, services: db.services, bookings: db.bookings, waitlist: db.waitlist, ledger: db.ledger, events: db.events.slice(0, 40), clients: db.clients, summary: summary() };
}));

// ---- agents ----
app.post('/api/chat', wrap((req) => chat({ role: 'client', ...req.body })));
app.post('/api/owner/chat', wrap((req) => chat({ role: 'owner', clientName: 'owner', ...req.body })));

// ---- PayPal approval: client approved the hold in the PayPal button ----
app.post('/api/bookings/:id/approve', wrap(async (req) => bk.confirmApproval(req.params.id, req.body.orderId)));
app.get('/api/bookings/:id', wrap(async (req) => store.booking(req.params.id) || { error: 'not found' }));
app.get('/api/offers', wrap(async (req) => {
  const name = String(req.query.client || '').toLowerCase();
  return store.get().bookings.filter((b) => b.offer && b.status === 'PENDING_APPROVAL' && b.clientName.toLowerCase() === name);
}));
app.post('/api/bookings/:id/cancel', wrap(async (req) => bk.cancelByClient(req.params.id)));

// ---- owner actions (dashboard buttons) ----
app.post('/api/owner/bookings/:id/attended', wrap(async (req) => bk.markAttended(req.params.id)));
app.post('/api/owner/bookings/:id/no-show', wrap(async (req) => bk.proposeNoShow(req.params.id)));
app.post('/api/owner/bookings/:id/confirm-charge', wrap(async (req) => bk.ownerConfirmCharge(req.params.id, req.body.amount)));
app.post('/api/owner/bookings/:id/waive', wrap(async (req) => bk.ownerWaive(req.params.id)));
app.post('/api/owner/reset', wrap(async () => { seed(); bk.onChange && listeners.forEach((r) => r.write('data: reset\n\n')); return { ok: true }; }));

// ---- PayPal webhooks: keep our ledger in sync with what PayPal reports ----
app.post('/api/webhooks/paypal', async (req, res) => {
  const event = req.body;
  try {
    const { verified } = await paypal.verifyWebhook(req.headers, event);
    store.logEvent('webhook', `PayPal ${event.event_type}${verified ? ' (verified)' : ' (unverified)'}`, { id: event.id });
    if (verified && event.event_type === 'PAYMENT.AUTHORIZATION.VOIDED') {
      const b = store.get().bookings.find((x) => x.authorizationId === event.resource?.id);
      if (b && b.status === 'HELD') { b.status = 'CANCELLED'; store.save(); }
    }
    for (const r of listeners) r.write(`data: ${Date.now()}\n\n`);
  } catch (e) { console.error('webhook', e.message); }
  res.sendStatus(200);
});

setInterval(() => bk.sweep(), 30_000);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`HoldFast on http://localhost:${port}  | PayPal: ${paypal.SIMULATED ? 'SIMULATED (add sandbox keys to .env)' : 'sandbox'} | AI: ${AI_MODE}`);
});
