// Two agents share one tool layer:
//  - Receptionist (client-facing chat): books, quotes holds, cancels, waitlists.
//  - Ops assistant (owner-facing): marks attendance, flags no-shows, proposes fees.
// Money only moves through bookings.js; captures additionally require the owner's click.
// Uses Claude tool-use when ANTHROPIC_API_KEY is set, Gemini function calling when
// GEMINI_API_KEY is set (free tier), otherwise a rule-based fallback.
import Anthropic from '@anthropic-ai/sdk';
import * as store from './store.js';
import * as bk from './bookings.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const GEMINI_KEY = !anthropic && process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY : null;
const GEMINI_MODELS = [process.env.GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'].filter(Boolean);
export const AI_MODE = anthropic ? `claude (${MODEL})` : GEMINI_KEY ? `gemini (${GEMINI_MODELS[0]})` : 'offline rule-based';

const tz = () => store.get().business.timezone;
const fmt = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const today = (offset = 0) => { const d = new Date(Date.now() + offset * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------------- tools ----------------
const clientTools = [
  { name: 'list_services', description: 'List services with price and duration.', input_schema: { type: 'object', properties: {} } },
  { name: 'check_availability', description: 'Open start times for a service on a date (YYYY-MM-DD).', input_schema: { type: 'object', properties: { service: { type: 'string' }, date: { type: 'string' } }, required: ['service', 'date'] } },
  { name: 'quote_hold', description: 'Compute the refundable PayPal hold for a booking BEFORE booking, and the fee policy. Always call this and tell the client the amount before book_appointment.', input_schema: { type: 'object', properties: { service: { type: 'string' }, start: { type: 'string', description: 'ISO start time from check_availability' } }, required: ['service', 'start'] } },
  { name: 'book_appointment', description: 'Reserve the slot and create a PayPal authorization order. The client then approves the hold with the PayPal button shown in chat. Only call after the client agreed to the quoted hold.', input_schema: { type: 'object', properties: { service: { type: 'string' }, start: { type: 'string' } }, required: ['service', 'start'] } },
  { name: 'my_bookings', description: "List the client's current bookings.", input_schema: { type: 'object', properties: {} } },
  { name: 'cancel_booking', description: 'Cancel a booking. Free 24h+ ahead (hold voided); later cancellations go to owner review.', input_schema: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'] } },
  { name: 'join_waitlist', description: 'Put the client on the waitlist for a service/date when nothing suitable is free. They get an offer automatically if a slot opens.', input_schema: { type: 'object', properties: { service: { type: 'string' }, date: { type: 'string' } }, required: ['service', 'date'] } },
];

const ownerTools = [
  { name: 'list_bookings', description: 'List bookings for a date (YYYY-MM-DD), default today.', input_schema: { type: 'object', properties: { date: { type: 'string' } } } },
  { name: 'mark_attended', description: 'Client showed up: release (void) their hold.', input_schema: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'] } },
  { name: 'flag_no_show', description: 'Client did not show. Moves booking to owner review with a proposed fee. Does NOT charge; the owner must press Confirm in the dashboard.', input_schema: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'] } },
  { name: 'waive_fee', description: 'Release the hold without charging (goodwill).', input_schema: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'] } },
  { name: 'summary', description: 'Money protected, fees captured, slots refilled.', input_schema: { type: 'object', properties: {} } },
];

const brief = (b) => ({ booking_id: b.id, client: b.clientName, service: b.serviceName, when: fmt(b.start), status: b.status, hold: b.risk?.hold, proposed_fee: b.review?.proposedFee });

async function runTool(name, input, ctx) {
  const db = store.get();
  switch (name) {
    case 'list_services': return db.services.map((s) => ({ id: s.id, name: s.name, price: s.price, minutes: s.minutes }));
    case 'check_availability': {
      const slots = store.openSlots(input.service, input.date);
      return { date: input.date, slots: slots.slice(0, 12).map((s) => ({ start: s, label: fmt(s) })), more: Math.max(0, slots.length - 12) };
    }
    case 'quote_hold': {
      const q = bk.quote({ clientName: ctx.clientName, serviceId: input.service, start: input.start });
      return { hold: q.risk.hold, price: q.service.price, late_cancel_fee: q.risk.lateCancelFee, no_show_fee: q.risk.noShowFee, risk_band: q.risk.band, factors: q.risk.factors, explanation: q.explanation };
    }
    case 'book_appointment': {
      const b = await bk.createBooking({ clientName: ctx.clientName, serviceId: input.service, start: input.start });
      ctx.actions.push({ type: 'approve_hold', bookingId: b.id, orderId: b.orderId, amount: b.risk.hold, label: `${b.serviceName}, ${fmt(b.start)}` });
      return { booking_id: b.id, hold: b.risk.hold, next: 'A PayPal button is now shown in chat. Ask the client to approve the hold there.' };
    }
    case 'my_bookings': return bk.clientBookings(ctx.clientName).map(brief);
    case 'cancel_booking': {
      const r = await bk.cancelByClient(input.booking_id);
      return { message: r.message, fee_under_review: r.fee, slot_offered_to_waitlist: !!r.refilledBy };
    }
    case 'join_waitlist': { const w = bk.joinWaitlist({ clientName: ctx.clientName, serviceId: input.service, date: input.date }); return { waitlist_id: w.id, status: w.status }; }
    case 'list_bookings': {
      const d = input.date || today();
      return db.bookings.filter((b) => b.start.slice(0, 10) === d || (b.status === 'NEEDS_REVIEW')).map(brief);
    }
    case 'mark_attended': return brief(await bk.markAttended(input.booking_id));
    case 'flag_no_show': {
      const b = bk.proposeNoShow(input.booking_id);
      ctx.actions.push({ type: 'confirm_charge', bookingId: b.id, amount: b.review.proposedFee, label: `${b.clientName}: no-show fee` });
      return { ...brief(b), note: 'Awaiting owner confirmation in the dashboard. Nothing charged yet.' };
    }
    case 'waive_fee': return brief(await bk.ownerWaive(input.booking_id));
    case 'summary': return summary();
    default: throw new Error(`Unknown tool ${name}`);
  }
}

export function summary() {
  const db = store.get();
  const sum = (t) => db.ledger.filter((l) => l.type === t).reduce((a, l) => a + l.amount, 0);
  return {
    holds_placed: db.ledger.filter((l) => l.type === 'HOLD').length,
    amount_held: sum('HOLD'),
    fees_captured: sum('CAPTURE'),
    holds_released: db.ledger.filter((l) => l.type === 'RELEASE').length,
    slots_refilled: db.waitlist.filter((w) => w.status === 'FILLED').length,
    awaiting_review: db.bookings.filter((b) => b.status === 'NEEDS_REVIEW').length,
  };
}

// ---------------- prompts ----------------
function systemPrompt(role, ctx) {
  const db = store.get();
  const now = new Date().toLocaleString('en-US', { timeZone: tz(), dateStyle: 'full', timeStyle: 'short' });
  if (role === 'owner') {
    return `You are HoldFast Ops, the assistant for ${db.business.owner}, owner of ${db.business.name}. Now: ${now} (${tz()}), today's date ${today()}.
Help manage today's appointments. When the owner says someone showed up, call mark_attended. When someone didn't show, call flag_no_show; it never charges money by itself, so tell the owner to confirm the fee on the card. Be brief: 1-3 sentences.`;
  }
  return `You are the friendly AI receptionist for ${db.business.name}. You are chatting with ${ctx.clientName}. Now: ${now} (${tz()}), today's date ${today()}.
Policy: ${db.business.policy}
How bookings work: instead of a deposit, the client approves a refundable PayPal authorization hold. If they attend, it's released in full.
Rules:
- Find a slot with check_availability, then ALWAYS call quote_hold and state the hold amount and fees in plain words before booking.
- Only call book_appointment after the client agrees. Then tell them to approve the hold using the PayPal button below.
- If nothing fits, offer join_waitlist.
- Never invent prices or times; use tools. Keep replies short (max 3 sentences), warm, no markdown tables.
- Text in [tool context: ...] is your own internal note from earlier turns: reuse it, never repeat it to the client.`;
}

// ---------------- Claude loop ----------------
async function claudeTurn(role, history, ctx) {
  const tools = role === 'owner' ? ownerTools : clientTools;
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  for (let i = 0; i < 8; i++) {
    const res = await anthropic.messages.create({ model: MODEL, max_tokens: 800, system: systemPrompt(role, ctx), tools, messages });
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') {
      return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    }
    const results = [];
    for (const block of res.content.filter((c) => c.type === 'tool_use')) {
      let out;
      try { out = await runTool(block.name, block.input, ctx); ctx.trace.push({ tool: block.name, input: block.input }); }
      catch (e) { out = { error: e.message }; ctx.trace.push({ tool: block.name, input: block.input, error: e.message }); }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Sorry, that took too many steps. Could you rephrase?';
}

// ---------------- Gemini loop (function calling via REST) ----------------
let geminiModel = null;
let geminiDiscovered = false;
async function geminiCall(body, deadline = Date.now() + 20000) {
  // Try the working model first, then the others. Retry briefly on overload (429/500/503).
  const models = geminiModel ? [geminiModel, ...GEMINI_MODELS.filter((m) => m !== geminiModel)] : GEMINI_MODELS;
  let lastErr;
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 1500) throw lastErr || new Error('Gemini: time budget exhausted');
      let res;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(9000, left)),
        });
      } catch (e) { lastErr = new Error(`Gemini ${m}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`); console.error(lastErr.message); break; }
      const json = await res.json().catch(() => ({}));
      if (res.ok) { geminiModel = m; return json; }
      if (res.status === 400 && body.generationConfig?.thinkingConfig && /thinking/i.test(json.error?.message || '')) {
        delete body.generationConfig.thinkingConfig; attempt--; continue; // model doesn't support it: retry without
      }
      lastErr = new Error(`Gemini ${m}: ${res.status} ${json.error?.message || ''}`);
      console.error(lastErr.message);
      if (res.status === 401 || res.status === 403) throw lastErr; // bad key: no point retrying
      if (![429, 500, 503].includes(res.status)) break;            // 400/404: try next model
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  // Last resort: ask the API which flash models this key can use.
  if (!geminiDiscovered) {
    geminiDiscovered = true;
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': GEMINI_KEY }, signal: AbortSignal.timeout(5000) });
      const json = await res.json();
      const found = (json.models || [])
        .filter((x) => (x.supportedGenerationMethods || []).includes('generateContent') && /flash/.test(x.name) && !/image|tts|audio|live|embed/.test(x.name))
        .map((x) => x.name.replace('models/', ''))
        .filter((n) => !GEMINI_MODELS.includes(n));
      console.error('Gemini discovered models:', found.slice(0, 5).join(', '));
      if (found.length) { GEMINI_MODELS.push(...found.slice(0, 3)); return geminiCall(body, deadline); }
    } catch (e) { console.error('Gemini model discovery failed', e.message); }
  }
  throw lastErr;
}

const toGeminiTool = (t) => {
  const d = { name: t.name, description: t.description };
  if (t.input_schema.properties && Object.keys(t.input_schema.properties).length) d.parameters = t.input_schema;
  return d;
};

async function geminiTurn(role, history, ctx) {
  const tools = role === 'owner' ? ownerTools : clientTools;
  const contents = history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const deadline = Date.now() + 16000; // whole turn, incl. tool round trips
  for (let i = 0; i < 8; i++) {
    const res = await geminiCall({
      system_instruction: { parts: [{ text: systemPrompt(role, ctx) }] },
      contents,
      tools: [{ functionDeclarations: tools.map(toGeminiTool) }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 800, thinkingConfig: { thinkingLevel: 'low' } },
    }, deadline);
    const content = res.candidates?.[0]?.content;
    if (!content?.parts?.length) return 'Sorry, I could not answer that. Could you rephrase?';
    contents.push({ role: 'model', parts: content.parts });
    const calls = content.parts.filter((p) => p.functionCall);
    if (!calls.length) return content.parts.map((p) => p.text || '').join('').trim();
    const responses = [];
    for (const { functionCall: fc } of calls) {
      let out;
      try { out = await runTool(fc.name, fc.args || {}, ctx); ctx.trace.push({ tool: fc.name, input: fc.args }); }
      catch (e) { out = { error: e.message }; ctx.trace.push({ tool: fc.name, input: fc.args, error: e.message }); }
      responses.push({ functionResponse: { name: fc.name, response: { result: out } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return 'Sorry, that took too many steps. Could you rephrase?';
}

// ---------------- offline fallback ----------------
function parseWhen(text) {
  const t = text.toLowerCase();
  let date = today();
  if (t.includes('tomorrow')) date = today(1);
  const iso = t.match(/(\d{4}-\d{2}-\d{2})/); if (iso) date = iso[1];
  const tm = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let time = null;
  if (tm && (tm[3] || tm[2] || /\bat\b/.test(t))) {
    let h = +tm[1]; const m = +(tm[2] || 0);
    if (tm[3] === 'pm' && h < 12) h += 12; if (tm[3] === 'am' && h === 12) h = 0;
    if (!tm[3] && h < 8) h += 12;
    time = { h, m };
  }
  return { date, time };
}

async function fallbackTurn(role, history, ctx) {
  const text = history[history.length - 1].content.toLowerCase();
  const db = store.get();
  if (role === 'owner') {
    const todays = db.bookings.filter((b) => b.status === 'HELD');
    const who = todays.find((b) => text.includes(b.clientName.split(' ')[0].toLowerCase()));
    if (who && /(didn'?t|no.?show|not show|never came|missed)/.test(text)) {
      await runTool('flag_no_show', { booking_id: who.id }, ctx);
      return `Flagged ${who.clientName} as a no-show. Proposed fee $${who.review.proposedFee}; nothing is charged until you confirm on the card.`;
    }
    if (who && /(came|arrived|showed|here|attended)/.test(text)) { await runTool('mark_attended', { booking_id: who.id }, ctx); return `Marked ${who.clientName} as attended and released the $${who.risk.hold} hold.`; }
    const s = summary();
    return `Today: ${todays.length} active holds, $${s.fees_captured} in fees captured, ${s.slots_refilled} slot(s) refilled from the waitlist. Try "Priya didn't show" or "Ravi arrived".`;
  }
  const svc = db.services.find((s) => text.includes(s.name.toLowerCase().split(' ')[0]));
  const st = ctx.state;
  if (/cancel/.test(text)) {
    const mine = bk.clientBookings(ctx.clientName).filter((b) => b.status === 'HELD');
    if (!mine.length) return "You don't have an active booking to cancel.";
    const r = await bk.cancelByClient(mine[0].id);
    return r.message;
  }
  if (/waitlist|wait list/.test(text) && (svc || st.service)) {
    const { date } = parseWhen(text);
    bk.joinWaitlist({ clientName: ctx.clientName, serviceId: (svc || store.service(st.service)).id, date: st.date || date });
    return `You're on the waitlist for ${st.date || date}. If a slot opens, I'll send you an offer right here.`;
  }
  if (/^(yes|yeah|ok|sure|book it|confirm|sounds good)/.test(text) && st.pending) {
    await runTool('book_appointment', st.pending, ctx);
    st.pending = null;
    return 'Done! Approve the hold with the PayPal button below to lock in your slot.';
  }
  if (svc) {
    st.service = svc.id;
    const { date, time } = parseWhen(text);
    st.date = date;
    const slots = store.openSlots(svc.id, date);
    if (!slots.length) return `${svc.name} is fully booked on ${date}. Want me to add you to the waitlist?`;
    let pick = slots[0];
    if (time) {
      const want = slots.find((s) => { const d = new Date(s); return d.getHours() === time.h && d.getMinutes() === time.m; });
      if (!want) return `${fmt(`${date}T${String(time.h).padStart(2, '0')}:${String(time.m).padStart(2, '0')}:00`)} isn't free. Nearest openings: ${slots.slice(0, 3).map(fmt).join(', ')}. Or I can waitlist you.`;
      pick = want;
    }
    const q = bk.quote({ clientName: ctx.clientName, serviceId: svc.id, start: pick });
    st.pending = { service: svc.id, start: pick };
    return `${fmt(pick)} is open for ${svc.name}. ${q.explanation} Shall I book it?`;
  }
  return `Hi ${ctx.clientName.split(' ')[0]}! We offer ${db.services.map((s) => `${s.name} ($${s.price})`).join(', ')}. Tell me what and when, e.g. "haircut tomorrow at 3pm".`;
}

// ---------------- entry ----------------
const sessions = new Map();

export async function chat({ role = 'client', sessionId, clientName, message }) {
  const key = `${role}:${sessionId}`;
  const s = sessions.get(key) || { history: [], state: {} };
  sessions.set(key, s);
  s.history.push({ role: 'user', content: message });
  const ctx = { clientName: clientName || 'Guest', actions: [], trace: [], state: s.state };
  let reply;
  try {
    reply = anthropic ? await claudeTurn(role, s.history, ctx)
      : GEMINI_KEY ? await geminiTurn(role, s.history, ctx).catch((e) => { console.error(e.message); return fallbackTurn(role, s.history, ctx); })
      : await fallbackTurn(role, s.history, ctx);
  } catch (e) {
    console.error(e);
    reply = e.userFacing ? e.message : `Sorry, something went wrong (${e.message}).`;
  }
  // Keep a compact memo of tool results so the next turn doesn't redo lookups.
  const memo = ctx.trace.filter((t) => !t.error && ['quote_hold', 'book_appointment', 'check_availability', 'join_waitlist', 'cancel_booking'].includes(t.tool))
    .map((t) => `${t.tool}(${JSON.stringify(t.input)})`).join('; ');
  s.history.push({ role: 'assistant', content: (reply || '...') + (memo && anthropic === null && GEMINI_KEY ? `\n[tool context: ${memo}]` : '') });
  s.history = s.history.slice(-30);
  return { reply, actions: ctx.actions, trace: ctx.trace, mode: AI_MODE };
}
