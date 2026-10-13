import { Decimal, exposure } from '../../shared/money/money.js';

export type ProgramStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface ProgramState {
  id: string;
  externalId: string;
  clientRef: string;
  currency: string;
  creditLimit: Decimal;
  externalUtilized: Decimal;
  reserved: Decimal;
  status: ProgramStatus;
  openBlockingBreaks: number;
}

export interface FxQuote {
  id: string;
  rateId: string;
  status: 'ACTIVE' | 'SUSPENDED';
  rate?: Decimal;
  effectiveAsOf: Date;
}

export interface ReserveInput {
  originalAmount: Decimal;
  currency: string;
  dueDate: string;
}

export interface AssessContext {
  businessDate: string;
  now: Date;
  fxMaxAgeMs: number;
}

export type DeclineCode =
  | 'INVOICE_PAST_DUE'
  | 'PROGRAM_SUSPENDED'
  | 'PROGRAM_CLOSED'
  | 'PROGRAM_ON_HOLD'
  | 'FX_RATE_UNAVAILABLE'
  | 'FX_RATE_SUSPENDED'
  | 'FX_RATE_STALE'
  | 'INSUFFICIENT_CAPACITY';

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

export type Assessment =
  | { outcome: 'decline'; code: DeclineCode; amount?: Decimal; fx?: FxQuote }
  | { outcome: 'reserve'; amount: Decimal; fx?: FxQuote };

export interface Availability {
  available: Decimal;
  overLimit: Decimal;
}

export function availability(program: ProgramState): Availability {
  const free = program.creditLimit
    .minus(program.externalUtilized)
    .minus(program.reserved);
  return {
    available: Decimal.max(free, 0),
    overLimit: Decimal.max(free.neg(), 0),
  };
}

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
  if (amount.gt(availability(program).available)) {
    return { outcome: 'decline', code: 'INSUFFICIENT_CAPACITY', amount, fx: quote };
  }

  return { outcome: 'reserve', amount, fx: quote };
}