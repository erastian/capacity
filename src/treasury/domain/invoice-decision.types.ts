import type { Decimal } from 'decimal.js';
import type { FxRateStatus, FxRateType } from '../adapter/commands.types.js';

export type ReservationStatus = 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED' | 'CANCELLED';

export type ReleaseReason = 'REPAYMENT' | 'WRITE_OFF' | 'CANCELLATION' | 'REVERSAL';

export interface ReservationView {
  id: string;
  programId: string;
  programExternalId: string;
  invoiceId: string;
  originalAmount: Decimal;
  originalCurrency: string;
  amount: Decimal;
  releasedOriginalAmount: Decimal;
  releasedAmount: Decimal;
  status: ReservationStatus;
  fundingRef: string | null;
  valuationRate: Decimal | undefined;
}

export interface StoredRelease {
  id: string;
  reason: ReleaseReason;
  externalRef: string;
  originalAmount: Decimal;
  paymentId: string | null;
  paymentAmount: Decimal | null;
  paymentCurrency: string | null;
  paymentRateId: string | null;
  cancellationReason: string | null;
  writeOffReason: string | null;
  reversesExternalRef: string | null;
  reversed: boolean;
}

export interface StoredFunding {
  reservationId: string;
  returned: boolean;
}

export interface ConversionQuote {
  rateId: string;
  from: string;
  to: string;
  rateType: FxRateType;
  status: FxRateStatus;
  rate?: Decimal;
}

export interface InvoiceFacts {
  sameRef?: StoredRelease;
  target?: StoredRelease;
  funding?: StoredFunding;
  quote?: ConversionQuote;
}

export type InvoiceBreakReason =
  | 'UNKNOWN_INVOICE'
  | 'PROGRAM_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'OVERPAYMENT'
  | 'FX_RATE_MISMATCH'
  | 'FX_SETTLED_AMOUNT_MISMATCH'
  | 'CANCELLATION_AFTER_SETTLEMENT'
  | 'CANCELLATION_WHILE_FUNDED'
  | 'FUNDED_AFTER_CANCELLATION'
  | 'FUNDING_CONFLICT'
  | 'EXTERNAL_REF_CONFLICT'
  | 'UNKNOWN_RELEASE';

export type InvoiceRejectReason = InvoiceBreakReason | 'RESERVATION_CLOSED' | 'RELEASE_ALREADY_REVERSED' | 'RELEASE_NOT_REVERSIBLE';

export interface InvoiceBreak {
  reason: InvoiceBreakReason;
  blocking: boolean;
  reservationId: string | null;
  essence: Record<string, string>;
  details: Record<string, unknown>;
}

export interface NewRelease {
  reason: ReleaseReason;
  externalRef: string;
  originalAmount: Decimal;
  amount: Decimal;
  paymentId: string | null;
  paymentAmount: Decimal | null;
  paymentCurrency: string | null;
  paymentRateId: string | null;
  cancellationReason: string | null;
  writeOffReason: string | null;
  reversesReleaseId: string | null;
}

export interface ReservationBalances {
  releasedOriginalAmount: Decimal;
  releasedAmount: Decimal;
  status: ReservationStatus;
}

export type InvoiceEffect =
  | { kind: 'FUND'; fundingRef: string }
  | { kind: 'RETURN_FUNDING'; fundingRef: string }
  | { kind: 'RELEASE'; release: NewRelease; balances: ReservationBalances; reservedDelta: Decimal };

export type InvoicePlan =
  | { outcome: 'APPLIED'; effect: InvoiceEffect }
  | { outcome: 'STALE' }
  | { outcome: 'REJECTED'; reason: InvoiceRejectReason; break?: InvoiceBreak }
  | { outcome: 'AWAIT_RATE'; rateId: string };
