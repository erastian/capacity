import { Decimal } from 'decimal.js';
import type { InvoiceCommand } from '../adapter/commands.types.js';
import { decideInvoiceCommand } from './invoice-decision.js';
import type { InvoicePlan, ReservationView, StoredRelease } from './invoice-decision.types.js';

const PROGRAM = 'program-1';

const d = (value: string) => new Decimal(value);

const reservation = (patch: Partial<ReservationView> = {}): ReservationView => ({
  id: 'res-1',
  programId: PROGRAM,
  programExternalId: 'P-1',
  invoiceId: 'INV-1',
  originalAmount: d('1000.00'),
  originalCurrency: 'USD',
  amount: d('900.0000'),
  releasedOriginalAmount: d('0'),
  releasedAmount: d('0'),
  status: 'ACTIVE',
  fundingRef: null,
  valuationRate: d('0.9'),
  ...patch,
});

const partiallyPaid = (paid: string, released: string) =>
  reservation({ releasedOriginalAmount: d(paid), releasedAmount: d(released), status: 'PARTIALLY_RELEASED' });

const paidOff = reservation({ releasedOriginalAmount: d('1000.00'), releasedAmount: d('900.0000'), status: 'RELEASED' });

const cancelledReservation = reservation({
  releasedOriginalAmount: d('1000.00'),
  releasedAmount: d('900.0000'),
  status: 'CANCELLED',
});

const stored = (patch: Partial<StoredRelease> = {}): StoredRelease => ({
  id: 'rel-1',
  reason: 'REPAYMENT',
  externalRef: 'A-1',
  originalAmount: d('400.00'),
  paymentId: 'PAY-1',
  paymentAmount: d('400.00'),
  paymentCurrency: 'USD',
  paymentRateId: null,
  cancellationReason: null,
  writeOffReason: null,
  reversesExternalRef: null,
  reversed: false,
  ...patch,
});

const allocation = (patch: Partial<Extract<InvoiceCommand, { type: 'INVOICE_PAYMENT_ALLOCATED' }>> = {}): InvoiceCommand => ({
  type: 'INVOICE_PAYMENT_ALLOCATED',
  programId: 'P-1',
  invoiceId: 'INV-1',
  allocationId: 'A-1',
  paymentId: 'PAY-1',
  payment: { amount: d('400.00'), currency: 'USD' },
  settledAmount: { amount: d('400.00'), currency: 'USD' },
  fxRateId: null,
  ...patch,
});

const converted = (payment: string, settled: string): InvoiceCommand =>
  allocation({
    payment: { amount: d(payment), currency: 'GBP' },
    settledAmount: { amount: d(settled), currency: 'USD' },
    fxRateId: 'R-CONV',
  });

const conversion = {
  rateId: 'R-CONV',
  from: 'GBP',
  to: 'USD',
  rateType: 'CONVERSION' as const,
  status: 'ACTIVE' as const,
  rate: d('1.2345'),
};

const funded = (fundingRef = 'F-1'): InvoiceCommand => ({
  type: 'INVOICE_FUNDED',
  programId: 'P-1',
  invoiceId: 'INV-1',
  fundingRef,
});

const fundingReturned = (fundingRef = 'F-1'): InvoiceCommand => ({
  type: 'INVOICE_FUNDING_RETURNED',
  programId: 'P-1',
  invoiceId: 'INV-1',
  fundingRef,
});

const writeOff = (amount: string, writeOffReason = 'ROUNDING_TOLERANCE'): InvoiceCommand => ({
  type: 'INVOICE_BALANCE_WRITTEN_OFF',
  programId: 'P-1',
  invoiceId: 'INV-1',
  writeOffId: 'W-1',
  amount: { amount: d(amount), currency: 'USD' },
  writeOffReason,
});

const cancellation = (cancellationReason = 'SUPPLIER_WITHDREW'): InvoiceCommand => ({
  type: 'INVOICE_FUNDING_CANCELLED',
  programId: 'P-1',
  invoiceId: 'INV-1',
  cancellationId: 'C-1',
  cancellationReason,
});

const reversal = (externalRef = 'A-1'): InvoiceCommand => ({
  type: 'INVOICE_RELEASE_REVERSED',
  programId: 'P-1',
  invoiceId: 'INV-1',
  reversalId: 'REV-1',
  externalRef,
});

function released(plan: InvoicePlan) {
  if (plan.outcome !== 'APPLIED' || plan.effect.kind !== 'RELEASE') throw new Error(`not a release: ${plan.outcome}`);
  const { release, balances, reservedDelta } = plan.effect;
  return {
    releaseOriginal: release.originalAmount.toString(),
    releaseAmount: release.amount.toFixed(4),
    releasedOriginal: balances.releasedOriginalAmount.toString(),
    releasedAmount: balances.releasedAmount.toFixed(4),
    status: balances.status,
    reservedDelta: reservedDelta.toFixed(4),
  };
}

const rejected = (plan: InvoicePlan) =>
  plan.outcome === 'REJECTED'
    ? { reason: plan.reason, blocking: plan.break?.blocking, hasBreak: plan.break !== undefined }
    : { outcome: plan.outcome };

describe('decideInvoiceCommand', () => {
  describe('invoice lookup', () => {
    it('rejects an unknown invoice with a non-blocking break keyed by the invoice', () => {
      const plan = decideInvoiceCommand(funded(), PROGRAM, undefined, {});
      expect(plan).toMatchObject({
        outcome: 'REJECTED',
        reason: 'UNKNOWN_INVOICE',
        break: { blocking: false, reservationId: null, essence: { invoiceId: 'INV-1' } },
      });
    });

    it('rejects an invoice of another programme with PROGRAM_MISMATCH on the reservation', () => {
      const plan = decideInvoiceCommand(funded(), 'program-2', reservation(), {});
      expect(plan).toMatchObject({
        outcome: 'REJECTED',
        reason: 'PROGRAM_MISMATCH',
        break: { blocking: false, reservationId: 'res-1', details: { expected: 'P-1', received: 'P-1' } },
      });
    });
  });

  describe('INVOICE_FUNDED', () => {
    it.each([
      ['an active reservation', reservation()],
      ['a partially paid reservation', partiallyPaid('400.00', '360.0000')],
    ])('funds %s', (_, current) => {
      expect(decideInvoiceCommand(funded(), PROGRAM, current, {})).toEqual({
        outcome: 'APPLIED',
        effect: { kind: 'FUND', fundingRef: 'F-1' },
      });
    });

    it('treats the active funding resent as stale', () => {
      const plan = decideInvoiceCommand(funded(), PROGRAM, reservation({ fundingRef: 'F-1' }), {
        funding: { reservationId: 'res-1', returned: false },
      });
      expect(plan).toEqual({ outcome: 'STALE' });
    });

    it.each<[string, ReservationView, { reservationId: string; returned: boolean } | undefined, string, boolean]>([
      ['a ref of another reservation', reservation(), { reservationId: 'res-2', returned: false }, 'FUNDING_CONFLICT', false],
      ['a returned ref of this reservation', reservation(), { reservationId: 'res-1', returned: true }, 'FUNDING_CONFLICT', false],
      ['a cancelled reservation', cancelledReservation, undefined, 'FUNDED_AFTER_CANCELLATION', true],
      ['a paid-off reservation', paidOff, undefined, 'FUNDING_CONFLICT', false],
      ['another live funding', reservation({ fundingRef: 'F-0' }), undefined, 'FUNDING_CONFLICT', false],
    ])('rejects %s', (_, current, funding, reason, blocking) => {
      const plan = decideInvoiceCommand(funded(), PROGRAM, current, funding ? { funding } : {});
      expect(rejected(plan)).toEqual({ reason, blocking, hasBreak: true });
    });
  });

  describe('INVOICE_FUNDING_RETURNED', () => {
    it('returns the live funding', () => {
      const plan = decideInvoiceCommand(fundingReturned(), PROGRAM, reservation({ fundingRef: 'F-1' }), {
        funding: { reservationId: 'res-1', returned: false },
      });
      expect(plan).toEqual({ outcome: 'APPLIED', effect: { kind: 'RETURN_FUNDING', fundingRef: 'F-1' } });
    });

    it('treats an already returned funding as stale', () => {
      const plan = decideInvoiceCommand(fundingReturned(), PROGRAM, reservation(), {
        funding: { reservationId: 'res-1', returned: true },
      });
      expect(plan).toEqual({ outcome: 'STALE' });
    });

    it.each([
      ['an unknown funding', undefined],
      ['a funding of another reservation', { reservationId: 'res-2', returned: false }],
    ])('rejects %s', (_, funding) => {
      const plan = decideInvoiceCommand(fundingReturned(), PROGRAM, reservation(), funding ? { funding } : {});
      expect(rejected(plan)).toEqual({ reason: 'FUNDING_CONFLICT', blocking: false, hasBreak: true });
    });
  });

  describe('INVOICE_PAYMENT_ALLOCATED', () => {
    it('releases the exposure difference of a partial payment', () => {
      expect(released(decideInvoiceCommand(allocation(), PROGRAM, reservation(), {}))).toEqual({
        releaseOriginal: '400',
        releaseAmount: '360.0000',
        releasedOriginal: '400',
        releasedAmount: '360.0000',
        status: 'PARTIALLY_RELEASED',
        reservedDelta: '-360.0000',
      });
    });

    it('keeps the exposure rounded up and returns the exact remainder on the last payment', () => {
      const current = reservation({ amount: d('913.7000'), valuationRate: d('0.9137') });
      const first = released(
        decideInvoiceCommand(
          allocation({ payment: { amount: d('333.33'), currency: 'USD' }, settledAmount: { amount: d('333.33'), currency: 'USD' } }),
          PROGRAM,
          current,
          {},
        ),
      );
      expect(first).toMatchObject({ releasedAmount: '304.5636', reservedDelta: '-304.5636' });

      const rest = released(
        decideInvoiceCommand(
          allocation({ allocationId: 'A-2', payment: { amount: d('666.67'), currency: 'USD' }, settledAmount: { amount: d('666.67'), currency: 'USD' } }),
          PROGRAM,
          { ...current, releasedOriginalAmount: d('333.33'), releasedAmount: d('304.5636'), status: 'PARTIALLY_RELEASED' },
          {},
        ),
      );
      expect(rest).toEqual({
        releaseOriginal: '666.67',
        releaseAmount: '609.1364',
        releasedOriginal: '1000',
        releasedAmount: '913.7000',
        status: 'RELEASED',
        reservedDelta: '-609.1364',
      });
    });

    it('releases the outstanding as is when the invoice is in the programme currency', () => {
      const current = reservation({ originalCurrency: 'USD', amount: d('1000.00'), valuationRate: undefined });
      expect(released(decideInvoiceCommand(allocation(), PROGRAM, current, {}))).toMatchObject({
        releaseAmount: '400.0000',
        reservedDelta: '-400.0000',
      });
    });

    it('rejects a payment above the outstanding as OVERPAYMENT', () => {
      const plan = decideInvoiceCommand(allocation(), PROGRAM, partiallyPaid('700.00', '630.0000'), {});
      expect(plan).toMatchObject({
        outcome: 'REJECTED',
        reason: 'OVERPAYMENT',
        break: { blocking: false, details: { outstanding: '300.00', received: '400.00' } },
      });
    });

    it('rejects a payment on a paid-off reservation as OVERPAYMENT', () => {
      expect(rejected(decideInvoiceCommand(allocation(), PROGRAM, paidOff, {}))).toMatchObject({ reason: 'OVERPAYMENT' });
    });

    it('rejects a settled amount in another currency with a non-blocking CURRENCY_MISMATCH', () => {
      const plan = decideInvoiceCommand(
        allocation({ payment: { amount: d('400.00'), currency: 'EUR' }, settledAmount: { amount: d('400.00'), currency: 'EUR' } }),
        PROGRAM,
        reservation(),
        {},
      );
      expect(rejected(plan)).toEqual({ reason: 'CURRENCY_MISMATCH', blocking: false, hasBreak: true });
    });

    it('treats the same allocation resent with the same content as stale', () => {
      expect(decideInvoiceCommand(allocation(), PROGRAM, reservation(), { sameRef: stored({ originalAmount: d('400.0000') }) })).toEqual({
        outcome: 'STALE',
      });
    });

    it.each<[string, Partial<StoredRelease>]>([
      ['another amount', { originalAmount: d('399.00') }],
      ['another payment', { paymentId: 'PAY-2' }],
      ['another kind of release', { reason: 'WRITE_OFF' }],
    ])('rejects the same allocationId with %s as EXTERNAL_REF_CONFLICT', (_, patch) => {
      const plan = decideInvoiceCommand(allocation(), PROGRAM, reservation(), { sameRef: stored(patch) });
      expect(rejected(plan)).toEqual({ reason: 'EXTERNAL_REF_CONFLICT', blocking: false, hasBreak: true });
    });

    describe('in another currency', () => {
      it('waits for a quote that has not arrived', () => {
        expect(decideInvoiceCommand(converted('100.00', '123.45'), PROGRAM, reservation(), {})).toEqual({
          outcome: 'AWAIT_RATE',
          rateId: 'R-CONV',
        });
      });

      it('applies the share rounded down to the invoice minor unit', () => {
        const plan = decideInvoiceCommand(converted('100.01', '123.46'), PROGRAM, reservation(), { quote: conversion });
        expect(released(plan)).toMatchObject({ releaseOriginal: '123.46', status: 'PARTIALLY_RELEASED' });
        expect(plan).toMatchObject({
          effect: { release: { paymentCurrency: 'GBP', paymentRateId: 'R-CONV', paymentAmount: d('100.01') } },
        });
      });

      it('caps the share at the outstanding', () => {
        const plan = decideInvoiceCommand(converted('41.00', '50.00'), PROGRAM, partiallyPaid('950.00', '855.0000'), {
          quote: conversion,
        });
        expect(released(plan)).toMatchObject({ status: 'RELEASED', releaseAmount: '45.0000' });
      });

      it('rejects a settled amount that does not match our share', () => {
        const plan = decideInvoiceCommand(converted('100.00', '123.46'), PROGRAM, reservation(), { quote: conversion });
        expect(plan).toMatchObject({
          outcome: 'REJECTED',
          reason: 'FX_SETTLED_AMOUNT_MISMATCH',
          break: { blocking: false, details: { expected: '123.45', received: '123.46' } },
        });
      });

      it.each<[string, Partial<typeof conversion> & { rate?: Decimal }]>([
        ['a valuation quote', { rateType: 'VALUATION' as 'CONVERSION' }],
        ['another pair', { from: 'EUR' }],
        ['a reversed pair', { from: 'USD', to: 'GBP' }],
        ['a suspended quote', { status: 'SUSPENDED' as 'ACTIVE', rate: undefined }],
      ])('rejects %s as FX_RATE_MISMATCH', (_, patch) => {
        const plan = decideInvoiceCommand(converted('100.00', '123.45'), PROGRAM, reservation(), {
          quote: { ...conversion, ...patch },
        });
        expect(rejected(plan)).toEqual({ reason: 'FX_RATE_MISMATCH', blocking: false, hasBreak: true });
      });
    });
  });

  describe('INVOICE_BALANCE_WRITTEN_OFF', () => {
    it('writes off the tail and settles the reservation', () => {
      const plan = decideInvoiceCommand(writeOff('0.03'), PROGRAM, partiallyPaid('999.97', '899.9730'), {});
      expect(released(plan)).toEqual({
        releaseOriginal: '0.03',
        releaseAmount: '0.0270',
        releasedOriginal: '1000',
        releasedAmount: '900.0000',
        status: 'RELEASED',
        reservedDelta: '-0.0270',
      });
      expect(plan).toMatchObject({ effect: { release: { reason: 'WRITE_OFF', writeOffReason: 'ROUNDING_TOLERANCE' } } });
    });

    it('rejects a write-off above the outstanding', () => {
      expect(rejected(decideInvoiceCommand(writeOff('0.04'), PROGRAM, partiallyPaid('999.97', '899.9730'), {}))).toMatchObject({
        reason: 'OVERPAYMENT',
      });
    });

    it('treats the same write-off resent as stale and another reason as a conflict', () => {
      const same = stored({ reason: 'WRITE_OFF', externalRef: 'W-1', originalAmount: d('0.03'), paymentId: null, paymentAmount: null, paymentCurrency: null, writeOffReason: 'ROUNDING_TOLERANCE' });
      expect(decideInvoiceCommand(writeOff('0.03'), PROGRAM, paidOff, { sameRef: same })).toEqual({ outcome: 'STALE' });
      expect(rejected(decideInvoiceCommand(writeOff('0.03', 'BANK_CHARGES'), PROGRAM, paidOff, { sameRef: same }))).toMatchObject({
        reason: 'EXTERNAL_REF_CONFLICT',
      });
    });
  });

  describe('INVOICE_FUNDING_CANCELLED', () => {
    it('cancels an untouched reservation and releases the full exposure', () => {
      const plan = decideInvoiceCommand(cancellation(), PROGRAM, reservation(), {});
      expect(released(plan)).toEqual({
        releaseOriginal: '1000',
        releaseAmount: '900.0000',
        releasedOriginal: '1000',
        releasedAmount: '900.0000',
        status: 'CANCELLED',
        reservedDelta: '-900.0000',
      });
    });

    it.each<[string, ReservationView, string, boolean | undefined, boolean]>([
      ['a paid-off reservation', paidOff, 'RESERVATION_CLOSED', undefined, false],
      ['a cancelled reservation', cancelledReservation, 'RESERVATION_CLOSED', undefined, false],
      ['a partly settled reservation', partiallyPaid('400.00', '360.0000'), 'CANCELLATION_AFTER_SETTLEMENT', false, true],
      ['a funded reservation', reservation({ fundingRef: 'F-1' }), 'CANCELLATION_WHILE_FUNDED', false, true],
    ])('rejects %s', (_, current, reason, blocking, hasBreak) => {
      expect(rejected(decideInvoiceCommand(cancellation(), PROGRAM, current, {}))).toEqual({ reason, blocking, hasBreak });
    });

    it('treats the same cancellation resent as stale', () => {
      const same = stored({ reason: 'CANCELLATION', externalRef: 'C-1', originalAmount: d('1000.00'), paymentId: null, paymentAmount: null, paymentCurrency: null, cancellationReason: 'SUPPLIER_WITHDREW' });
      expect(decideInvoiceCommand(cancellation(), PROGRAM, cancelledReservation, { sameRef: same })).toEqual({ outcome: 'STALE' });
    });
  });

  describe('INVOICE_RELEASE_REVERSED', () => {
    it('restores the debt and takes the capacity back', () => {
      const plan = decideInvoiceCommand(reversal(), PROGRAM, partiallyPaid('400.00', '360.0000'), { target: stored() });
      expect(released(plan)).toEqual({
        releaseOriginal: '400',
        releaseAmount: '360.0000',
        releasedOriginal: '0',
        releasedAmount: '0.0000',
        status: 'ACTIVE',
        reservedDelta: '360.0000',
      });
      expect(plan).toMatchObject({ effect: { release: { reason: 'REVERSAL', externalRef: 'REV-1', reversesReleaseId: 'rel-1' } } });
    });

    it('reopens a paid-off reservation', () => {
      const plan = decideInvoiceCommand(reversal(), PROGRAM, paidOff, { target: stored() });
      expect(released(plan)).toMatchObject({ status: 'PARTIALLY_RELEASED', releasedOriginal: '600' });
    });

    it('brings a cancelled reservation back to ACTIVE', () => {
      const target = stored({ id: 'rel-c', reason: 'CANCELLATION', externalRef: 'C-1', originalAmount: d('1000.00'), paymentId: null, paymentAmount: null, paymentCurrency: null });
      const plan = decideInvoiceCommand(reversal('C-1'), PROGRAM, cancelledReservation, { target });
      expect(released(plan)).toMatchObject({ status: 'ACTIVE', reservedDelta: '900.0000' });
    });

    it.each<[string, StoredRelease | undefined, string, boolean | undefined, boolean]>([
      ['an unknown release', undefined, 'UNKNOWN_RELEASE', true, true],
      ['a reversal', stored({ reason: 'REVERSAL', reversesExternalRef: 'A-0' }), 'RELEASE_NOT_REVERSIBLE', undefined, false],
      ['a reversed release', stored({ reversed: true }), 'RELEASE_ALREADY_REVERSED', undefined, false],
    ])('rejects reversing %s', (_, target, reason, blocking, hasBreak) => {
      const plan = decideInvoiceCommand(reversal(), PROGRAM, partiallyPaid('400.00', '360.0000'), target ? { target } : {});
      expect(rejected(plan)).toEqual({ reason, blocking, hasBreak });
    });

    it('treats the same reversal resent as stale and one of another release as a conflict', () => {
      const same = stored({ id: 'rel-r', reason: 'REVERSAL', externalRef: 'REV-1', reversesExternalRef: 'A-1' });
      expect(decideInvoiceCommand(reversal(), PROGRAM, reservation(), { sameRef: same })).toEqual({ outcome: 'STALE' });
      expect(rejected(decideInvoiceCommand(reversal('A-2'), PROGRAM, reservation(), { sameRef: same }))).toMatchObject({
        reason: 'EXTERNAL_REF_CONFLICT',
      });
    });
  });
});