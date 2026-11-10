// No-show risk -> hold size.
// Deliberately uses ONLY booking behaviour with this business. No names, demographics,
// location or device data -- so the hold can't become a proxy for who someone is.

export function scoreRisk({ client, start, now = new Date(), service }) {
  const factors = [];
  let score = 0.25; // baseline for a typical booking

  const visits = client.attended + client.noShows + client.lateCancels;
  if (visits === 0) {
    score += 0.15;
    factors.push({ factor: 'First visit with this business', impact: +0.15 });
  } else {
    const flakeRate = (client.noShows + 0.5 * client.lateCancels) / visits;
    const delta = +(flakeRate * 0.6 - Math.min(client.attended, 10) * 0.025).toFixed(2);
    score += delta;
    factors.push({
      factor: `History: ${client.attended} attended, ${client.noShows} no-show, ${client.lateCancels} late cancel`,
      impact: delta,
    });
  }

  const leadHours = (new Date(start) - now) / 36e5;
  if (leadHours > 24 * 14) { score += 0.12; factors.push({ factor: 'Booked more than 2 weeks ahead', impact: +0.12 }); }
  else if (leadHours < 4) { score -= 0.1; factors.push({ factor: 'Same-day booking (high intent)', impact: -0.1 }); }

  const hour = new Date(start).getHours();
  if (hour < 10 || hour >= 18) { score += 0.08; factors.push({ factor: 'Early/late slot', impact: +0.08 }); }

  score = Math.max(0.05, Math.min(0.95, score));

  // Hold = between 20% and 100% of price, never above the service price, min 5.
  const pct = 0.2 + 0.8 * score;
  const hold = Math.min(service.price, Math.max(5, Math.round(service.price * pct)));
  // Fee charged on a no-show; late cancel charges half of that.
  const noShowFee = hold;
  const lateCancelFee = Math.round(hold / 2);

  const band = score < 0.3 ? 'low' : score < 0.55 ? 'medium' : 'high';
  return { score: +score.toFixed(2), band, hold, noShowFee, lateCancelFee, factors };
}

export function explainRisk(r, service) {
  const top = [...r.factors].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))[0];
  return `I'll place a $${r.hold} hold on your PayPal for the ${service.name} ($${service.price}). ` +
    `It's not a charge: if you come, it's released in full. ` +
    `Cancel 24h+ ahead: free. Late cancel: $${r.lateCancelFee}. No-show: $${r.noShowFee}.` +
    (top ? ` (Hold size based on: ${top.factor.toLowerCase()}.)` : '');
}
