// Demo data: a salon with a realistic mix of reliable and flaky clients.
import * as store from './store.js';
import { scoreRisk } from './risk.js';
import { pathToFileURL } from 'node:url';

const at = (dayOffset, h, m = 0) => {
  const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString();
};

export function seed() {
  const db = {
    business: {
      name: 'Studio Lumen Salon', owner: 'Asha', timezone: process.env.TZ || 'Asia/Kolkata',
      hours: { open: 9, close: 19 },
      policy: 'Free cancellation up to 24h before. Late cancellation or no-show: part of the hold is charged.',
    },
    services: [
      { id: 'svc_cut', name: 'Haircut', price: 40, minutes: 45 },
      { id: 'svc_color', name: 'Color & Gloss', price: 120, minutes: 120 },
      { id: 'svc_blow', name: 'Blow-dry', price: 30, minutes: 30 },
      { id: 'svc_facial', name: 'Facial', price: 70, minutes: 60 },
    ],
    clients: [
      { id: 'cli_priya', name: 'Priya Sharma', email: 'priya@example.com', attended: 1, noShows: 2, lateCancels: 1 },
      { id: 'cli_ravi', name: 'Ravi Kumar', email: 'ravi@example.com', attended: 9, noShows: 0, lateCancels: 0 },
      { id: 'cli_meera', name: 'Meera Iyer', email: 'meera@example.com', attended: 4, noShows: 0, lateCancels: 1 },
      { id: 'cli_sam', name: 'Sam Lee', email: 'sam@example.com', attended: 6, noShows: 1, lateCancels: 0 },
    ],
    bookings: [], waitlist: [], ledger: [], events: [],
  };
  store.reset(db);

  // Pre-existing held bookings (already authorized) so the dashboard isn't empty.
  const mk = (cid, sid, start, authSuffix) => {
    const c = db.clients.find((x) => x.id === cid); const s = db.services.find((x) => x.id === sid);
    const risk = scoreRisk({ client: c, start, service: s, now: new Date(Date.now() - 3 * 864e5) });
    const b = {
      id: store.id('bk'), clientId: c.id, clientName: c.name, serviceId: s.id, serviceName: s.name, price: s.price,
      start, end: new Date(new Date(start).getTime() + s.minutes * 60000).toISOString(),
      status: 'HELD', risk, source: 'seed', orderId: `ORDER-SEED-${authSuffix}`, authorizationId: `AUTH-SEED-${authSuffix}`,
      createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), seeded: true,
    };
    db.bookings.push(b);
    db.ledger.push({ id: store.id('led'), at: b.createdAt, bookingId: b.id, client: c.name, service: s.name, type: 'HOLD', amount: risk.hold, ref: b.authorizationId, status: 'Authorized (seed)' });
    return b;
  };
  mk('cli_sam', 'svc_cut', at(1, 11), 'A1');
  mk('cli_meera', 'svc_facial', at(1, 14), 'A2');
  mk('cli_priya', 'svc_color', at(2, 10), 'A3');
  store.save();
  store.logEvent('system', 'Demo data loaded');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) { seed(); console.log('Seeded.'); }
