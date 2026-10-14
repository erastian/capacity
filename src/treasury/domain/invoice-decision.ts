import { Decimal } from 'decimal.js';
import { minorUnits } from '../../shared/money/currency.js';
import { exposure, formatAmount } from '../../shared/money/money.js';
import type {
  InvoiceBalanceWrittenOff,
  InvoiceCommand,
  InvoiceFunded,
  InvoiceFundingCancelled,
  InvoiceFundingReturned,
  InvoicePaymentAllocated,
  InvoiceReleaseReversed,
} from '../adapter/commands.types.js';
import type {
  InvoiceBreakReason,
  InvoiceFacts,
  InvoicePlan,
  NewRelease,
  ReservationBalances,
  ReservationView,
  StoredRelease,
} from './invoice-decision.types.js';

const STALE: InvoicePlan = { outcome: 'STALE' };

const NO_RELEASE_DETAILS = {
  paymentId: null,
  paymentAmount: null,
  paymentCurrency: null,
  paymentRateId: null,
  cancellationReason: null,
  writeOffReason: null,
  reversesReleaseId: null,
};

function invoiceAmount(value: Decimal, reservation: ReservationView): string {
  return formatAmount(value, minorUnits(reservation.originalCurrency));
}

function outstanding(reservation: ReservationView): Decimal {
  return reservation.originalAmount.minus(reservation.releasedOriginalAmount);
}

function breakOn(
  reservation: ReservationView,
  reason: InvoiceBreakReason,
  blocking: boolean,
  details: Record<string, unknown>,
  essence: Record<string, string> = {},
): InvoicePlan {
  return {
    outcome: 'REJECTED',
    reason,
    break: {
      reason,
      blocking,
      reservationId: reservation.id,
      essence: { reservationId: reservation.id, ...essence },
      details: { invoiceId: reservation.invoiceId, ...details },
    },
  };
}

function rebalance(
  reservation: ReservationView,
  releasedOriginalAmount: Decimal,
  cancelled: boolean,
): { balances: ReservationBalances; reservedDelta: Decimal } {
  const remaining = reservation.originalAmount.minus(releasedOriginalAmount);
  const releasedAmount = reservation.amount.minus(exposure(remaining, reservation.valuationRate));
  const status = releasedOriginalAmount.isZero()
    ? 'ACTIVE'
    : releasedOriginalAmount.lt(reservation.originalAmount)
      ? 'PARTIALLY_RELEASED'
      : cancelled
        ? 'CANCELLED'
        : 'RELEASED';
  return {
    balances: { releasedOriginalAmount, releasedAmount, status },
    reservedDelta: reservation.releasedAmount.minus(releasedAmount),
  };
}

function release(reservation: ReservationView, releasedOriginalAmount: Decimal, cancelled: boolean, row: Omit<NewRelease, 'amount'>): InvoicePlan {
  const { balances, reservedDelta } = rebalance(reservation, releasedOriginalAmount, cancelled);
  return {
    outcome: 'APPLIED',
    effect: { kind: 'RELEASE', release: { ...row, amount: reservedDelta.abs() }, balances, reservedDelta },
  };
}

const sameDecimal = (left: Decimal | null, right: Decimal | null) => (left === null || right === null ? left === right : left.eq(right));

function sameRelease(stored: StoredRelease, expected: Partial<StoredRelease>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const actual = stored[key as keyof StoredRelease];
    return value instanceof Decimal || actual instanceof Decimal ? sameDecimal(actual as Decimal | null, value as Decimal | null) : actual === value;
  });
}

function repeated(reservation: ReservationView, stored: StoredRelease, expected: Partial<StoredRelease>): InvoicePlan {
  return sameRelease(stored, expected)
    ? STALE
    : breakOn(reservation, 'EXTERNAL_REF_CONFLICT', false, { externalRef: stored.externalRef, releaseId: stored.id });
}

function currencyMismatch(reservation: ReservationView, received: string): InvoicePlan {
  return breakOn(reservation, 'CURRENCY_MISMATCH', false, {
    expected: reservation.originalCurrency,
    received,
  });
}

function overpayment(reservation: ReservationView, received: Decimal): InvoicePlan {
  return breakOn(reservation, 'OVERPAYMENT', false, {
    outstanding: invoiceAmount(outstanding(reservation), reservation),
    received: invoiceAmount(received, reservation),
  });
}

function funded(command: InvoiceFunded, reservation: ReservationView, facts: InvoiceFacts): InvoicePlan {
  const { funding } = facts;
  const fundingRef = command.fundingRef;
  if (funding && funding.reservationId === reservation.id && !funding.returned && reservation.fundingRef === fundingRef) {
    return STALE;
  }
  if (funding) return breakOn(reservation, 'FUNDING_CONFLICT', false, { fundingRef, problem: 'FUNDING_REF_REUSED' });
  if (reservation.status === 'CANCELLED') {
    return breakOn(reservation, 'FUNDED_AFTER_CANCELLATION', true, { fundingRef });
  }
  if (reservation.status === 'RELEASED') {
    return breakOn(reservation, 'FUNDING_CONFLICT', false, { fundingRef, problem: 'FUNDED_AFTER_SETTLEMENT' });
  }
  if (reservation.fundingRef !== null) {
    return breakOn(reservation, 'FUNDING_CONFLICT', false, {
      fundingRef,
      problem: 'ANOTHER_FUNDING_ACTIVE',
      activeFundingRef: reservation.fundingRef,
    });
  }
  return { outcome: 'APPLIED', effect: { kind: 'FUND', fundingRef } };
}

function fundingReturned(command: InvoiceFundingReturned, reservation: ReservationView, facts: InvoiceFacts): InvoicePlan {
  const { funding } = facts;
  if (!funding || funding.reservationId !== reservation.id) {
    return breakOn(reservation, 'FUNDING_CONFLICT', false, { fundingRef: command.fundingRef, problem: 'UNKNOWN_FUNDING' });
  }
  if (funding.returned) return STALE;
  return { outcome: 'APPLIED', effect: { kind: 'RETURN_FUNDING', fundingRef: command.fundingRef } };
}

function allocated(command: InvoicePaymentAllocated, reservation: ReservationView, facts: InvoiceFacts): InvoicePlan {
  const { payment, settledAmount } = command;
  if (facts.sameRef) {
    return repeated(reservation, facts.sameRef, {
      reason: 'REPAYMENT',
      originalAmount: settledAmount.amount,
      paymentId: command.paymentId,
      paymentAmount: payment.amount,
      paymentCurrency: payment.currency,
      paymentRateId: command.fxRateId,
    });
  }
  if (settledAmount.currency !== reservation.originalCurrency) return currencyMismatch(reservation, settledAmount.currency);

  let rate: Decimal | undefined;
  if (command.fxRateId !== null) {
    const quote = facts.quote;
    if (!quote) return { outcome: 'AWAIT_RATE', rateId: command.fxRateId };
    const fits =
      quote.rateType === 'CONVERSION' &&
      quote.from === payment.currency &&
      quote.to === reservation.originalCurrency &&
      quote.status === 'ACTIVE' &&
      quote.rate !== undefined;
    if (!fits) {
      return breakOn(reservation, 'FX_RATE_MISMATCH', false, {
        rateId: quote.rateId,
        expected: { rateType: 'CONVERSION', from: payment.currency, to: reservation.originalCurrency, status: 'ACTIVE' },
        received: { rateType: quote.rateType, from: quote.from, to: quote.to, status: quote.status },
      });
    }
    rate = quote.rate;
  }

  if (settledAmount.amount.gt(outstanding(reservation))) return overpayment(reservation, settledAmount.amount);

  if (rate) {
    const share = Decimal.min(
      payment.amount.mul(rate).toDecimalPlaces(minorUnits(reservation.originalCurrency), Decimal.ROUND_FLOOR),
      outstanding(reservation),
    );
    if (!share.eq(settledAmount.amount)) {
      return breakOn(reservation, 'FX_SETTLED_AMOUNT_MISMATCH', false, {
        rateId: command.fxRateId,
        expected: invoiceAmount(share, reservation),
        received: invoiceAmount(settledAmount.amount, reservation),
      });
    }
  }

  return release(reservation, reservation.releasedOriginalAmount.plus(settledAmount.amount), false, {
    ...NO_RELEASE_DETAILS,
    reason: 'REPAYMENT',
    externalRef: command.allocationId,
    originalAmount: settledAmount.amount,
    paymentId: command.paymentId,
    paymentAmount: payment.amount,
    paymentCurrency: payment.currency,
    paymentRateId: command.fxRateId,
  });
}

function writtenOff(command: InvoiceBalanceWrittenOff, reservation: ReservationView, facts: InvoiceFacts): InvoicePlan {
  const { amount } = command;
  if (facts.sameRef) {
    return repeated(reservation, facts.sameRef, {
      reason: 'WRITE_OFF',
      originalAmount: amount.amount,
      writeOffReason: command.writeOffReason,
    });
  }
  if (amount.currency !== reservation.originalCurrency) return currencyMismatch(reservation, amount.currency);
  if (amount.amount.gt(outstanding(reservation))) return overpayment(reservation, amount.amount);

  return release(reservation, reservation.releasedOriginalAmount.plus(amount.amount), false, {
    ...NO_RELEASE_DETAILS,
    reason: 'WRITE_OFF',
    externalRef: command.writeOffId,
    originalAmount: amount.amount,
    writeOffReason: command.writeOffReason,
  });
}

function cancelled(command: InvoiceFundingCancelled, reservation: ReservationView, facts: InvoiceFacts): InvoicePlan {
  if (facts.sameRef) {
    return repeated(reservation, facts.sameRef, {
      reason: 'CANCELLATION',
      cancellationReason: command.cancellationReason,
    });
  }
  if (reservation.status === 'RELEASED' || reservation.status === 'CANCELLED') {
    return { outcome: 'REJECTED', reason: 'RESERVATION_CLOSED' };
  }
  if (!reservation.releasedOriginalAmount.isZero()) {
    return breakOn(reservation, 'CANCELLATION_AFTER_SETTLEMENT', false, {
      settled: invoiceAmount(reservation.releasedOriginalAmount, reservation),
    });
  }
  if (reservation.fundingRef !== null) {
    return breakOn(reservation, 'CANCELLATION_WHILE_FUNDED', false, { activeFundingRef: reservation.fundingRef });
  }

  return release(reservation, reservation.originalAmount, true, {
    ...NO_RELEASE_DETAILS,
    reason: 'CANCELLATION',
    externalRef: command.cancellationId,
    originalAmount: outstanding(reservation),
    cancellationReason: command.cancellationReason,
  });
}

function reversed(command: InvoiceReleaseReversed, reservation: ReservationView, facts: InvoiceFacts): InvoicePlan {
  if (facts.sameRef) {
    return repeated(reservation, facts.sameRef, {
      reason: 'REVERSAL',
      reversesExternalRef: command.externalRef,
    });
  }
  const target = facts.target;
  if (!target) {
    const externalRef = { externalRef: command.externalRef };
    return breakOn(reservation, 'UNKNOWN_RELEASE', true, externalRef, externalRef);
  }
  if (target.reason === 'REVERSAL') return { outcome: 'REJECTED', reason: 'RELEASE_NOT_REVERSIBLE' };
  if (target.reversed) return { outcome: 'REJECTED', reason: 'RELEASE_ALREADY_REVERSED' };

  return release(reservation, reservation.releasedOriginalAmount.minus(target.originalAmount), false, {
    ...NO_RELEASE_DETAILS,
    reason: 'REVERSAL',
    externalRef: command.reversalId,
    originalAmount: target.originalAmount,
    reversesReleaseId: target.id,
  });
}

export function decideInvoiceCommand(command: InvoiceCommand, programId: string, reservation: ReservationView | undefined, facts: InvoiceFacts): InvoicePlan {
  if (!reservation) {
    return {
      outcome: 'REJECTED',
      reason: 'UNKNOWN_INVOICE',
      break: {
        reason: 'UNKNOWN_INVOICE',
        blocking: false,
        reservationId: null,
        essence: { invoiceId: command.invoiceId },
        details: { invoiceId: command.invoiceId },
      },
    };
  }
  if (reservation.programId !== programId) {
    return breakOn(reservation, 'PROGRAM_MISMATCH', false, {
      expected: reservation.programExternalId,
      received: command.programId,
    });
  }

  switch (command.type) {
    case 'INVOICE_FUNDED':
      return funded(command, reservation, facts);
    case 'INVOICE_FUNDING_RETURNED':
      return fundingReturned(command, reservation, facts);
    case 'INVOICE_PAYMENT_ALLOCATED':
      return allocated(command, reservation, facts);
    case 'INVOICE_BALANCE_WRITTEN_OFF':
      return writtenOff(command, reservation, facts);
    case 'INVOICE_FUNDING_CANCELLED':
      return cancelled(command, reservation, facts);
    case 'INVOICE_RELEASE_REVERSED':
      return reversed(command, reservation, facts);
  }
}
