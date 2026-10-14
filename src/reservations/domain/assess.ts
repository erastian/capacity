import { capacityOf } from '../../shared/money/capacity.js';
import { exposure } from '../../shared/money/money.js';
import type {
  AssessContext,
  Assessment,
  DeclineCode,
  FxQuote,
  ProgramState,
  ReserveInput,
} from './assess.types.js';

export const DECLINE_STATUS: Record<DeclineCode, 409 | 422> = {
  INVOICE_PAST_DUE: 422,
  PROGRAM_SUSPENDED: 409,
  PROGRAM_CLOSED: 409,
  PROGRAM_ON_HOLD: 409,
  FX_RATE_UNAVAILABLE: 422,
  FX_RATE_SUSPENDED: 422,
  FX_RATE_STALE: 422,
  INSUFFICIENT_CAPACITY: 409,
};

export function needsFx(program: ProgramState, input: ReserveInput): boolean {
  return input.currency !== program.currency;
}

function assessFx(
  fx: FxQuote | undefined,
  context: AssessContext,
): DeclineCode | undefined {
  if (!fx) return 'FX_RATE_UNAVAILABLE';
  if (fx.status === 'SUSPENDED' || !fx.rate) return 'FX_RATE_SUSPENDED';
  if (context.now.getTime() - fx.effectiveAsOf.getTime() > context.fxMaxAgeMs) {
    return 'FX_RATE_STALE';
  }
  return undefined;
}

export function assess(
  program: ProgramState,
  input: ReserveInput,
  fx: FxQuote | undefined,
  context: AssessContext,
): Assessment {
  if (input.dueDate < context.businessDate) {
    return { outcome: 'decline', code: 'INVOICE_PAST_DUE' };
  }
  if (program.status === 'SUSPENDED') {
    return { outcome: 'decline', code: 'PROGRAM_SUSPENDED' };
  }
  if (program.status === 'CLOSED') {
    return { outcome: 'decline', code: 'PROGRAM_CLOSED' };
  }
  if (program.openBlockingBreaks > 0) {
    return { outcome: 'decline', code: 'PROGRAM_ON_HOLD' };
  }

  const quote = needsFx(program, input) ? fx : undefined;
  if (needsFx(program, input)) {
    const fxDecline = assessFx(fx, context);
    if (fxDecline) return { outcome: 'decline', code: fxDecline, fx };
  }

  const amount = exposure(input.originalAmount, quote?.rate);
  if (amount.gt(capacityOf(program).available)) {
    return { outcome: 'decline', code: 'INSUFFICIENT_CAPACITY', amount, fx: quote };
  }

  return { outcome: 'reserve', amount, fx: quote };
}