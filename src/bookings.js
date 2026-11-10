// Booking lifecycle. Every money movement goes through here so the rules live in one place:
//   PENDING_APPROVAL -> HELD -> (ATTENDED: void) | (NEEDS_REVIEW -> CHARGED: capture | WAIVED: void)
//   OFFERED (waitlist) -> PENDING_APPROVAL -> HELD
import * as store from './store.js';
import * as paypal from './paypal.js';
import { scoreRisk, explainRisk } from './risk.js';

const FREE_CANCEL_HOURS = 24;
const OFFER_MINUTES = 15;
let notify = () => {};
export const onChange = (fn) => { notify = fn; };

function fail(msg) { const e = new Error(msg); e.userFacing = true; throw e; }

export function quote({ clientName, serviceId, start }) {
  const svc = store.service(serviceId) || fail(`Unknown service "${serviceId}"`);
  const client = store.findClient({ name: clientName });
  const risk = scoreRisk({ client, start, service: svc });
  return { service: svc, client, risk, explanation: explainRisk(risk, svc) };
}

export async function createBooking({ clientName, serviceId, start, source = 'chat' }) {
  const db = store.get();
  const svc = store.service(serviceId) || fail(`Unknown service "${serviceId}"`);
  const day = new Date(start);
  const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  if (!store.openSlots(svc.id, dateStr).includes(new Date(start).toISOString())) fail('That slot is no longer available.');

  const { client, risk } = quote({ clientName, serviceId: svc.id, start });
  const b = {
    id: store.id('bk'),
    clientId: client.id,
    clientName: client.name,
    serviceId: svc.id,
    serviceName: svc.name,
    price: svc.price,
    start: new Date(start).toISOString(),
    end: new Date(new Date(start).getTime() + svc.minutes * 60000).toISOString(),
    status: 'PENDING_APPROVAL',
    risk,
    source,
    createdAt: new Date().toISOString(),
  };
  const order = await paypal.createHoldOrder({
    bookingId: b.id,
    amount: risk.hold,
    description: `HoldFast hold: ${svc.name} at ${db.business.name}`,
  });
  b.orderId = order.id;
  db.bookings.push(b);
  store.save();
  store.logEvent('booking.created', `${client.name} requested ${svc.name}; hold quoted $${risk.hold} (${risk.band} risk)`, { bookingId: b.id });
  notify();
  return b;
}

/** Called after the buyer approves in the PayPal button. */
export async function confirmApproval(bookingId, orderId) {
  const b = store.booking(bookingId) || fail('Booking not found');
  if (b.status === 'HELD') return b;
  if (b.orderId !== orderId) fail('Order does not match booking');
  let auth;
  try { auth = await paypal.authorizeOrder(orderId); }
  catch (e) {
    const issue = e.details?.details?.[0]?.issue || '';
    if (/ORDER_NOT_APPROVED|PAYER_ACTION_REQUIRED/.test(issue)) fail('PayPal has not received your approval yet. Please complete the PayPal window.');
    if (/ORDER_ALREADY_AUTHORIZED/.test(issue)) fail('This hold was already placed.');
    throw e;
  }
  Object.assign(b, { status: 'HELD', authorizationId: auth.authorizationId, holdExpires: auth.expiration_time });
  store.save();
  store.addLedger({ bookingId: b.id, client: b.clientName, service: b.serviceName, type: 'HOLD', amount: b.risk.hold, ref: auth.authorizationId, status: 'Authorized' });
  store.logEvent('hold.placed', `$${b.risk.hold} hold placed for ${b.clientName} (${b.serviceName})`, { bookingId: b.id });
  // If this booking filled a waitlist offer, mark it.
  const w = store.get().waitlist.find((x) => x.offerBookingId === b.id);
  if (w) { w.status = 'FILLED'; store.save(); store.logEvent('waitlist.filled', `Slot refilled by ${b.clientName} from the waitlist`, { bookingId: b.id }); }
  notify();
  return b;
}

export async function cancelByClient(bookingId) {
  const b = store.booking(bookingId) || fail('Booking not found');
  if (['PENDING_APPROVAL', 'OFFERED'].includes(b.status)) {
    b.status = 'CANCELLED'; store.save(); notify();
    return { booking: b, fee: 0, message: 'Cancelled. No hold had been placed.' };
  }
  if (b.status !== 'HELD') fail(`Booking is ${b.status}, cannot cancel.`);
  const hoursLeft = (new Date(b.start) - Date.now()) / 36e5;
  let result;
  if (hoursLeft >= FREE_CANCEL_HOURS) {
    await paypal.voidHold(b.authorizationId);
    b.status = 'CANCELLED';
    store.addLedger({ bookingId: b.id, client: b.clientName, service: b.serviceName, type: 'RELEASE', amount: 0, ref: b.authorizationId, status: 'Voided (free cancel)' });
    result = { booking: b, fee: 0, message: `Cancelled free of charge. Your $${b.risk.hold} hold has been released.` };
  } else {
    b.status = 'NEEDS_REVIEW';
    b.review = { reason: 'LATE_CANCEL', proposedFee: b.risk.lateCancelFee, at: new Date().toISOString() };
    const c = store.client(b.clientId); c.lateCancels++;
    result = { booking: b, fee: b.risk.lateCancelFee, message: `Cancelled. Since it's within ${FREE_CANCEL_HOURS}h, a late-cancel fee of up to $${b.risk.lateCancelFee} may apply; ${store.get().business.owner} will review it.` };
  }
  store.save();
  store.logEvent('booking.cancelled', `${b.clientName} cancelled ${b.serviceName} (${result.fee ? 'late' : 'free'})`, { bookingId: b.id });
  const offer = await autofillSlot(b);
  notify();
  return { ...result, refilledBy: offer?.clientName };
}

export async function markAttended(bookingId) {
  const b = store.booking(bookingId) || fail('Booking not found');
  if (b.status !== 'HELD') fail(`Booking is ${b.status}.`);
  await paypal.voidHold(b.authorizationId);
  b.status = 'ATTENDED';
  store.client(b.clientId).attended++;
  store.save();
  store.addLedger({ bookingId: b.id, client: b.clientName, service: b.serviceName, type: 'RELEASE', amount: 0, ref: b.authorizationId, status: 'Voided (attended)' });
  store.logEvent('booking.attended', `${b.clientName} attended; hold released`, { bookingId: b.id });
  notify();
  return b;
}

/** Agent/owner flags a no-show. Nothing is charged until the owner confirms. */
export function proposeNoShow(bookingId) {
  const b = store.booking(bookingId) || fail('Booking not found');
  if (b.status !== 'HELD') fail(`Booking is ${b.status}.`);
  b.status = 'NEEDS_REVIEW';
  b.review = { reason: 'NO_SHOW', proposedFee: b.risk.noShowFee, at: new Date().toISOString() };
  store.client(b.clientId).noShows++;
  store.save();
  store.logEvent('review.needed', `No-show flagged for ${b.clientName}: proposed fee $${b.risk.noShowFee} (awaiting owner)`, { bookingId: b.id });
  notify();
  return b;
}

/** Human-in-the-loop: the ONLY path that captures money. */
export async function ownerConfirmCharge(bookingId, amount) {
  const b = store.booking(bookingId) || fail('Booking not found');
  if (b.status !== 'NEEDS_REVIEW') fail('Nothing to review on this booking.');
  const fee = Math.min(Number(amount ?? b.review.proposedFee), b.risk.hold);
  if (!(fee > 0)) fail('Fee must be positive.');
  const cap = await paypal.captureHold(b.authorizationId, fee, {
    note: `${b.review.reason === 'NO_SHOW' ? 'No-show' : 'Late cancellation'} fee, ${b.serviceName}`,
    final: true, // releases the remainder of the hold
  });
  b.status = 'CHARGED';
  b.charged = fee;
  store.save();
  store.addLedger({ bookingId: b.id, client: b.clientName, service: b.serviceName, type: 'CAPTURE', amount: fee, ref: cap.captureId, status: b.risk.hold - fee > 0 ? `Captured; $${(b.risk.hold - fee).toFixed(0)} released to client` : 'Captured in full' });
  store.logEvent('fee.captured', `Owner approved $${fee} ${b.review.reason === 'NO_SHOW' ? 'no-show' : 'late-cancel'} fee from ${b.clientName}`, { bookingId: b.id });
  notify();
  return b;
}

export async function ownerWaive(bookingId) {
  const b = store.booking(bookingId) || fail('Booking not found');
  if (!['NEEDS_REVIEW', 'HELD'].includes(b.status)) fail(`Booking is ${b.status}.`);
  await paypal.voidHold(b.authorizationId);
  b.status = 'WAIVED';
  store.save();
  store.addLedger({ bookingId: b.id, client: b.clientName, service: b.serviceName, type: 'RELEASE', amount: 0, ref: b.authorizationId, status: 'Voided (waived by owner)' });
  store.logEvent('fee.waived', `Owner waived the fee for ${b.clientName}`, { bookingId: b.id });
  notify();
  return b;
}

export function joinWaitlist({ clientName, serviceId, date }) {
  const svc = store.service(serviceId) || fail(`Unknown service "${serviceId}"`);
  const client = store.findClient({ name: clientName });
  const existing = store.get().waitlist.find((x) => x.clientId === client.id && x.serviceId === svc.id && x.date === date && ['WAITING', 'OFFERED'].includes(x.status));
  if (existing) return existing; // idempotent: never double-add the same person
  const w = { id: store.id('wl'), clientId: client.id, clientName: client.name, serviceId: svc.id, serviceName: svc.name, date, status: 'WAITING', createdAt: new Date().toISOString() };
  store.get().waitlist.push(w);
  store.save();
  store.logEvent('waitlist.joined', `${client.name} joined the waitlist for ${svc.name} on ${date}`);
  notify();
  return w;
}

/** A slot opened up: offer it to the first matching waitlister, with a fresh risk-sized hold. */
export async function autofillSlot(freed) {
  const db = store.get();
  const date = freed.start.slice(0, 10);
  const svcFreed = store.service(freed.serviceId);
  const w = db.waitlist.find((x) => {
    if (x.status !== 'WAITING' || x.date !== date) return false;
    const s = store.service(x.serviceId);
    return s && s.minutes <= svcFreed.minutes;
  });
  if (!w) return null;
  const svc = store.service(w.serviceId);
  const { client, risk } = quote({ clientName: w.clientName, serviceId: svc.id, start: freed.start });
  const b = {
    id: store.id('bk'), clientId: client.id, clientName: client.name, serviceId: svc.id, serviceName: svc.name,
    price: svc.price, start: freed.start, end: new Date(new Date(freed.start).getTime() + svc.minutes * 60000).toISOString(),
    status: 'OFFERED', risk, source: 'waitlist', createdAt: new Date().toISOString(),
    offerExpires: new Date(Date.now() + OFFER_MINUTES * 60000).toISOString(),
  };
  const order = await paypal.createHoldOrder({ bookingId: b.id, amount: risk.hold, description: `HoldFast hold: ${svc.name} at ${db.business.name}` });
  b.orderId = order.id;
  b.status = 'PENDING_APPROVAL';
  b.offer = true;
  db.bookings.push(b);
  w.status = 'OFFERED';
  w.offerBookingId = b.id;
  store.save();
  store.logEvent('waitlist.offered', `Slot freed; offered to ${client.name} from the waitlist ($${risk.hold} hold, ${OFFER_MINUTES} min to accept)`, { bookingId: b.id });
  notify();
  return b;
}

/** Expire stale offers and unapproved bookings so slots don't stay blocked. */
export function sweep() {
  const db = store.get();
  let changed = false;
  for (const b of db.bookings) {
    if (b.status === 'PENDING_APPROVAL') {
      const deadline = b.offerExpires ? new Date(b.offerExpires) : new Date(new Date(b.createdAt).getTime() + 30 * 60000);
      if (Date.now() > deadline) {
        b.status = 'EXPIRED'; changed = true;
        const w = db.waitlist.find((x) => x.offerBookingId === b.id);
        if (w) w.status = 'WAITING';
      }
    }
  }
  if (changed) { store.save(); notify(); }
}

export function clientBookings(clientName) {
  const c = store.findClient({ name: clientName });
  return store.get().bookings.filter((b) => b.clientId === c.id && !['CANCELLED', 'EXPIRED'].includes(b.status));
}
