// Tiny JSON-file store. Good enough for a hackathon; swap for Postgres later.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = process.env.DATA_FILE || path.resolve('data/db.json');

const empty = () => ({
  business: {
    name: 'Studio Lumen Salon',
    owner: 'Asha',
    timezone: 'Asia/Kolkata',
    hours: { open: 9, close: 19 },
    policy: 'Free cancellation up to 24h before. Late cancellation or no-show: part of the hold is charged.',
  },
  services: [],
  clients: [],
  bookings: [],
  waitlist: [],
  ledger: [],
  events: [],
});

let db = load();

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return empty(); }
}
export function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}
export function reset(data) { db = data || empty(); save(); }
export const get = () => db;
export const id = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`;

export function logEvent(type, message, data = {}) {
  const e = { id: id('evt'), at: new Date().toISOString(), type, message, data };
  db.events.unshift(e);
  db.events = db.events.slice(0, 200);
  save();
  return e;
}

export function addLedger(entry) {
  const row = { id: id('led'), at: new Date().toISOString(), ...entry };
  db.ledger.unshift(row);
  save();
  return row;
}

export function findClient({ name, email }) {
  const key = (email || name || '').trim().toLowerCase();
  let c = db.clients.find((x) => x.email?.toLowerCase() === key || x.name.toLowerCase() === key);
  if (!c && name) {
    c = { id: id('cli'), name, email: email || null, attended: 0, noShows: 0, lateCancels: 0, createdAt: new Date().toISOString() };
    db.clients.push(c);
    save();
  }
  return c;
}

export const service = (sid) => db.services.find((s) => s.id === sid || s.name.toLowerCase() === String(sid).toLowerCase());
export const booking = (bid) => db.bookings.find((b) => b.id === bid);
export const client = (cid) => db.clients.find((c) => c.id === cid);

/** Open slots for a service on a given date (YYYY-MM-DD), 30-minute grid. */
export function openSlots(serviceId, date) {
  const svc = service(serviceId);
  if (!svc) return [];
  const { open, close } = db.business.hours;
  const busy = db.bookings.filter((b) => ['HELD', 'PENDING_APPROVAL', 'CONFIRMED_NO_HOLD'].includes(b.status));
  const slots = [];
  for (let m = open * 60; m + svc.minutes <= close * 60; m += 30) {
    const start = new Date(`${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`);
    const end = new Date(start.getTime() + svc.minutes * 60000);
    if (start.getTime() < Date.now()) continue;
    const clash = busy.some((b) => new Date(b.start) < end && new Date(b.end) > start);
    if (!clash) slots.push(start.toISOString());
  }
  return slots;
}
