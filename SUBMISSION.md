# Devpost submission kit

## Project name
HoldFast: the AI receptionist that ends no-shows

## Tagline (one line)
No deposits, no empty chairs: an AI receptionist that books over chat and protects every slot with a risk-sized, refundable PayPal hold.

## Inspiration
Small appointment businesses lose money every time someone doesn't show up. Their only tools are blunt: charge everyone a deposit (and lose bookings) or charge nobody (and lose revenue). PayPal's authorization holds let us do something in between: reserve money, not take it.

## What it does
- A chat receptionist books appointments, explains the policy, and quotes a refundable hold sized to no-show risk.
- The client approves the hold with PayPal right inside the chat.
- If they show up, the hold is voided. If they cancel late or no-show, the agent proposes a fee and the owner confirms it with one click (a partial capture; the rest is released).
- When someone cancels, the agent offers the freed slot to the waitlist with a fresh hold. The calendar refills itself.
- The owner gets a live calendar, a review queue, an ops assistant ("Priya didn't show"), and an AG Grid ledger of every PayPal hold, capture and release.

## How we built it
Node/Express. PayPal Orders v2 (`intent: AUTHORIZE`), Payments v2 (authorize, partial capture with `final_capture`, void, reauthorize), PayPal JS SDK buttons, webhook signature verification, idempotency keys. Two Claude tool-use agents share one tool layer; every money movement goes through a single rules module. AG Grid for the ledger, Server-Sent Events for live updates, deployed on Render.

## Responsible AI
- The agent can never capture money. Only the owner's click does.
- Hold size uses booking behaviour only (attendance history, lead time, slot time), never personal attributes, and is always capped at the service price.
- Every hold is explainable: owners see the exact factors.

## Challenges
Designing the lifecycle so money is always in a consistent state: holds that expire, offers nobody accepts, partial captures that must release the remainder, waitlist offers racing with new bookings.

## What's next
SMS/WhatsApp channel, calendar sync (Google/Outlook), PayPal Vault for returning clients, Venmo for US clients, multi-staff scheduling.

## Built with
paypal, paypal-orders-api, paypal-payments-api, paypal-js-sdk, claude, anthropic, node.js, express, ag-grid, render

---

# Demo video script (target 2:45, record at 1440p, no copyrighted music)

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Empty salon chair photo you own / owner dashboard | "Asha runs a salon. Last month, eleven no-shows cost her almost a week of revenue. Deposits scare clients off. So she charges nothing, and loses." |
| 0:15–0:25 | Title card: HoldFast | "HoldFast is an AI receptionist that protects every slot with a refundable PayPal hold, sized to the risk." |
| 0:25–1:00 | Client chat as **Ravi** (reliable): "haircut today at 6pm" → $10 hold → approve PayPal (sandbox popup) → ✓ booked | "Ravi has come nine times. His hold is just ten dollars, and it's not a charge. He approves it with PayPal right in the chat." |
| 1:00–1:20 | Same request as **Priya** (2 no-shows): bigger hold | "Priya has missed twice. Same service, bigger hold. The AI explains why, and it only uses booking history, never who she is." |
| 1:20–1:50 | Client cancels late → owner dashboard: slot flashes, waitlist offer → switch to waitlister's chat, approve → calendar shows "↻ refilled" | "Now someone cancels last-minute. Within seconds, HoldFast offers the slot to the waitlist with a fresh hold. The calendar heals itself." |
| 1:50–2:20 | Owner chat: "Sam didn't show" → review card → Confirm charge $14 → AG Grid ledger shows CAPTURE + release | "When someone doesn't show, the agent proposes a fee, but it can't take money. Asha confirms with one click: a partial capture, and PayPal releases the rest." |
| 2:20–2:40 | Architecture slide: Orders v2 AUTHORIZE → authorize → partial capture / void / reauthorize, webhooks, Claude tool-use agents | "Under the hood: PayPal's authorize, partial capture and void lifecycle, verified webhooks, and two Claude agents with a human in the loop." |
| 2:40–2:50 | KPIs | "Reliable clients pay nothing. Empty chairs get filled. That's HoldFast." |

---

# Final checklist (deadline Nov 12, 12:00 PM PST = Nov 13, 1:30 AM IST)
- [ ] Public GitHub repo, **MIT license visible in the About section** (GitHub detects LICENSE automatically)
- [ ] Deployed on Render with real sandbox keys (not simulated). Badge in header should say "PayPal sandbox"
- [ ] Sandbox buyer credentials in README + Devpost "testing instructions"
- [ ] Video < 3:00, public on YouTube, no third-party music/logos
- [ ] Devpost: list AI tools used (Claude in-app agents + coding assistance)
- [ ] Mention "Best Use of Agentic Commerce", "Best Use of PayPal + AI", and the AG Grid sponsor prize in the description
- [ ] Submit at least 2–3 hours before the deadline
