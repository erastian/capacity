import type { FxRatePublished } from '../adapter/commands.types.js';
import type { FxRatePlan, StoredQuote } from './fx-rate-decision.types.js';

function sameContent(stored: StoredQuote, incoming: FxRatePublished): boolean {
  const sameRate = stored.rate === undefined || incoming.rate === undefined ? stored.rate === incoming.rate : stored.rate.eq(incoming.rate);
  return (
    stored.from === incoming.from &&
    stored.to === incoming.to &&
    stored.rateType === incoming.rateType &&
    stored.version === incoming.version &&
    stored.status === incoming.status &&
    sameRate
  );
}

export function decideFxRate(incoming: FxRatePublished, sameRateId: StoredQuote | undefined, samePairVersion: StoredQuote | undefined): FxRatePlan {
  if (sameRateId) {
    return sameContent(sameRateId, incoming) ? { outcome: 'STALE' } : { outcome: 'REJECTED', reason: 'FX_RATE_CONFLICT', conflictsWith: sameRateId.rateId };
  }
  if (samePairVersion) {
    return { outcome: 'REJECTED', reason: 'FX_RATE_CONFLICT', conflictsWith: samePairVersion.rateId };
  }
  return { outcome: 'APPLIED' };
}
