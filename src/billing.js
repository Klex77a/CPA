'use strict';
// Usage estimates are observations, not a bill. Missing usage is never free.
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round = (value) => Math.round(value * 1e6) / 1e6;
function costSummary(items) {
  let known = 0,
    missing = 0,
    unknownCalls = 0;
  for (const item of items) {
    const complete = item?.billing_complete !== false && finite(item?.cost_usd);
    known += finite(item?.known_cost_usd)
      ? item.known_cost_usd
      : finite(item?.cost_usd)
        ? item.cost_usd
        : 0;
    if (!complete) missing++;
    unknownCalls += Number.isSafeInteger(item?.unknown_call_count)
      ? Math.max(0, item.unknown_call_count)
      : complete
        ? 0
        : 1;
  }
  return {
    cost_usd: missing ? null : round(known),
    known_cost_usd: round(known),
    billing_complete: missing === 0,
    unknown_cost_count: missing,
    unknown_call_count: unknownCalls,
  };
}
function addJobCost(job, item) {
  const next = costSummary([item]);
  const known = finite(job.known_cost_usd)
    ? job.known_cost_usd
    : finite(job.cost_usd)
      ? job.cost_usd
      : 0;
  job.known_cost_usd = round(known + next.known_cost_usd);
  job.unknown_cost_count = (job.unknown_cost_count || 0) + next.unknown_cost_count;
  job.unknown_call_count = (job.unknown_call_count || 0) + next.unknown_call_count;
  job.billing_complete = job.unknown_cost_count === 0;
  job.cost_usd = job.billing_complete ? job.known_cost_usd : null;
}
module.exports = { costSummary, addJobCost };
