import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import type { OutboundEventType } from '../outbox/outbox.types.js';
import { writeOutbox } from '../outbox/outbox.writer.js';
import { type Tx, PrismaService } from '../shared/db/prisma.service.js';
import { minorUnits } from '../shared/money/currency.js';
import { capacityOf } from '../shared/money/capacity.js';
import type { CapacityBalances } from '../shared/money/capacity.types.js';
import { formatAmount, formatCapacity } from '../shared/money/money.js';
import { Clock } from '../shared/time/clock.js';
import { isInvoiceCommand, toCommand } from './adapter/commands.js';
import type {
  BreakResolved,
  FxRatePublished,
  InvoiceCommand,
  ProgramCommand,
  ProgramSnapshot,
  ReconciliationBatchCompleted,
} from './adapter/commands.types.js';
import { parseEnvelope } from './adapter/envelope.js';
import type { RawMessage } from './adapter/envelope.types.js';
import { DeadLetterPublisher } from './dead-letter.js';
import { closureCondition, versionAbove } from './domain/break-closure.js';
import type { BreakView } from './domain/break-closure.types.js';
import { decideFxRate } from './domain/fx-rate-decision.js';
import { decideInvoiceCommand } from './domain/invoice-decision.js';
import type {
  InvoiceBreak,
  InvoiceEffect,
  InvoiceFacts,
  ReleaseReason,
  ReservationView,
} from './domain/invoice-decision.types.js';
import { decideProgramCommand } from './domain/program-decision.js';
import type { BreakSpec, ProgramPlan, ProgramView } from './domain/program-decision.types.js';
import { InboundMetrics } from './inbound.metrics.js';
import { InboundRepository, KNOWN_TYPES } from './inbound.repository.js';
import type { AwaitingKind, Decision, ProcessingContext as Context } from './inbound.types.js';
import { ReconciliationBatches } from './reconciliation-batches.js';
import { writeStatus } from './status.writer.js';

const ZERO_BALANCES = (program: ProgramView): CapacityBalances => ({
  creditLimit: program.creditLimit.mul(0),
  externalUtilized: program.externalUtilized.mul(0),
  reserved: program.reserved,
});

const balancesOf = (program: ProgramView): CapacityBalances => ({
  creditLimit: program.creditLimit,
  externalUtilized: program.externalUtilized,
  reserved: program.reserved,
});

const effectiveAsOf = ({ envelope, coordinates }: Context): Date =>
  envelope.asOf < coordinates.timestamp ? envelope.asOf : coordinates.timestamp;

const snapshotBatch = (type: string, batchId: string | undefined): Pick<Decision, 'batch'> =>
  type === 'PROGRAM_SNAPSHOT' && batchId ? { batch: batchId } : {};

const RELEASE_EVENTS: Record<ReleaseReason, OutboundEventType> = {
  REPAYMENT: 'RESERVATION_RELEASED',
  WRITE_OFF: 'RESERVATION_RELEASED',
  CANCELLATION: 'RESERVATION_CANCELLED',
  REVERSAL: 'RESERVATION_RELEASE_REVERSED',
};

@Injectable()
export class InboundProcessor {
  private readonly logger = new Logger(InboundProcessor.name);
  private readonly publishAccepted: boolean;
  private readonly batchGraceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: InboundRepository,
    private readonly metrics: InboundMetrics,
    private readonly deadLetters: DeadLetterPublisher,
    private readonly batches: ReconciliationBatches,
    private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.publishAccepted = config.get('PUBLISH_ACCEPTED_STATUS', { infer: true });
    this.batchGraceMs = config.get('RECONCILIATION_BATCH_GRACE_SECONDS', { infer: true }) * 1000;
  }

  async process(raw: RawMessage): Promise<void> {
    this.metrics.received(raw.topic, raw.timestamp, this.clock.now());

    const parsed = parseEnvelope(raw);
    if (parsed.kind === 'unreadable') {
      await this.deadLetters.send(raw, `UNREADABLE_ENVELOPE: ${parsed.reason}`);
      this.metrics.deadLettered('UNREADABLE_ENVELOPE');
      return;
    }

    const envelope = parsed.envelope;
    this.metrics.checkClock(envelope, raw.timestamp);

    const decision = await this.prisma.inTransaction((tx) =>
      this.decide(tx, {
        envelope,
        coordinates: { topic: raw.topic, partition: raw.partition, offset: raw.offset, timestamp: raw.timestamp },
        partitionKey: raw.key ?? envelope.programId ?? envelope.messageId,
        fromParked: false,
      }),
    );

    if (decision.deadLetter) {
      await this.deadLetters.send(raw, decision.deadLetter);
      this.metrics.deadLettered(decision.deadLetter);
    }
    if (decision.batch) await this.batches.complete(decision.batch);
    if (decision.wake) await this.resolveParked(decision.wake);
    if (decision.wakeRate) await this.resolveAwaitingRate(decision.wakeRate);
  }

  async resolveAwaitingRate(rateId: string): Promise<void> {
    const programs = await this.prisma.inTransaction((tx) => this.repository.programsAwaitingRate(tx, rateId));
    for (const programExternalId of programs) await this.resolveParked(programExternalId);
  }

  async resolveParked(programExternalId: string): Promise<void> {
    for (;;) {
      const decision = await this.prisma.inTransaction(async (tx) => {
        const program = await this.repository.lockProgram(tx, programExternalId);
        if (!program) return undefined;
        const parked = await this.repository.nextResolvableParked(tx, programExternalId);
        if (!parked) return undefined;

        const resolved = await this.decide(tx, {
          envelope: parked.envelope,
          coordinates: parked.coordinates,
          partitionKey: programExternalId,
          fromParked: true,
        });
        if (!resolved.parked) await this.repository.markResolved(tx, parked.messageId);
        return resolved;
      });
      if (!decision) return;
      if (decision.batch) await this.batches.complete(decision.batch);
    }
  }

  async resolveAllParked(): Promise<void> {
    const programs = await this.prisma.inTransaction((tx) => this.repository.programsWithResolvableParked(tx));
    for (const programExternalId of programs) await this.resolveParked(programExternalId);
  }

  private async decide(tx: Tx, context: Context): Promise<Decision> {
    const { envelope } = context;
    const programExternalId = envelope.programId;
    const program = programExternalId ? await this.repository.lockProgram(tx, programExternalId) : undefined;

    if (!context.fromParked) {
      const duplicate = await this.answerDuplicate(tx, context, program);
      if (duplicate) return duplicate;
    }

    const result = toCommand(envelope);
    if (result.kind !== 'command') {
      const reason = result.kind === 'invalid' ? 'INVALID_FORMAT' : 'UNKNOWN_MESSAGE_TYPE';
      await this.repository.insertInbox(tx, envelope, context.coordinates, {
        type: KNOWN_TYPES.has(envelope.type) ? envelope.type : null,
        outcome: 'REJECTED',
        reason,
        programId: program?.id ?? null,
        programExternalId: programExternalId ?? null,
      });
      await this.status(tx, context, program, 'RJCT', { reason });
      this.metrics.decided(envelope.type, 'REJECTED');
      if (result.kind === 'invalid') this.logger.warn(`${envelope.messageId}: ${result.reason}`);
      return { deadLetter: reason, ...snapshotBatch(envelope.type, envelope.batchId) };
    }

    const command = result.command;
    if (command.type === 'FX_RATE_PUBLISHED') return this.applyRate(tx, context, command);
    if (command.type === 'RECONCILIATION_BATCH_COMPLETED') return this.applyBatch(tx, context, command);

    const creating = !program && command.type === 'PROGRAM_SNAPSHOT';
    const reservation =
      program && isInvoiceCommand(command) ? await this.repository.findReservation(tx, command.invoiceId) : undefined;
    const queue = reservation && reservation.programId === program?.id ? reservation.id : null;
    if (!context.fromParked && !creating) {
      const predecessor = await this.repository.lastUnresolvedParked(tx, command.programId, queue);
      if (predecessor) return this.park(tx, context, command, program, queue, 'PRECEDING_MESSAGE', predecessor);
    }
    if (!program && !creating) return this.park(tx, context, command, program, null, 'PROGRAM', command.programId);

    if (isInvoiceCommand(command)) return this.applyInvoice(tx, context, command, program!, reservation);
    if (command.type === 'BREAK_RESOLVED') return this.applyBreakResolution(tx, context, command, program!);
    const decision = await this.apply(tx, context, command, program, decideProgramCommand(command, program));
    return { ...decision, ...snapshotBatch(command.type, envelope.batchId) };
  }

  private async applyBatch(tx: Tx, context: Context, command: ReconciliationBatchCompleted): Promise<Decision> {
    const { envelope, coordinates } = context;
    const existing = await this.repository.findBatch(tx, command.batchId);
    const outcome = !existing ? 'APPLIED' : existing.programCount === command.programCount ? 'STALE' : 'REJECTED';
    const reason = outcome === 'REJECTED' ? 'BATCH_CONFLICT' : null;
    this.metrics.decided(command.type, outcome);

    await this.repository.insertInbox(tx, envelope, coordinates, {
      type: command.type,
      outcome,
      reason,
      programId: null,
      programExternalId: null,
    });
    if (outcome === 'REJECTED') {
      this.logger.warn(
        `BATCH_CONFLICT: batch ${command.batchId} announced ${command.programCount} programs, earlier ${existing!.programCount}`,
      );
      await this.status(tx, context, undefined, 'RJCT', { reason });
      return {};
    }
    if (outcome === 'APPLIED') {
      const deadlineAt = new Date(coordinates.timestamp.getTime() + this.batchGraceMs);
      await this.repository.insertBatch(tx, command.batchId, command.programCount, envelope.messageId, deadlineAt);
    }
    await this.status(tx, context, undefined, 'ACCP');
    return { batch: command.batchId };
  }

  private async applyBreakResolution(
    tx: Tx,
    context: Context,
    command: BreakResolved,
    program: ProgramView,
  ): Promise<Decision> {
    const { envelope, coordinates } = context;
    const found = await this.repository.findBreak(tx, command.breakId, program);
    const reason = !found
      ? 'UNKNOWN_BREAK'
      : found.resolvedAt
        ? null
        : (await this.closable(tx, found, program))
          ? null
          : 'BREAK_NOT_RESOLVED';
    const outcome = reason ? 'REJECTED' : found!.resolvedAt ? 'STALE' : 'APPLIED';
    this.metrics.decided(command.type, outcome);

    await this.repository.insertInbox(tx, envelope, coordinates, {
      type: command.type,
      outcome,
      reason,
      programId: program.id,
      programExternalId: command.programId,
    });
    if (outcome === 'APPLIED') await this.closeBreak(tx, found!, program, envelope.messageId);

    const references = { breakId: command.breakId };
    if (reason) {
      await this.status(tx, context, program, 'RJCT', { reason, references });
    } else {
      await this.status(tx, context, program, 'ACCP', { references });
    }
    return {};
  }

  private async resolveListedBreaks(
    tx: Tx,
    snapshot: ProgramSnapshot,
    program: ProgramView,
    messageId: string,
  ): Promise<void> {
    for (const breakId of snapshot.resolvedBreaks) {
      const found = await this.repository.findBreak(tx, breakId, program);
      const result = !found
        ? 'UNKNOWN_BREAK'
        : found.resolvedAt
          ? 'ALREADY_RESOLVED'
          : (await this.closable(tx, found, program))
            ? 'RESOLVED'
            : 'BREAK_NOT_RESOLVED';
      this.metrics.snapshotBreak(result);
      if (result === 'RESOLVED') {
        await this.closeBreak(tx, found!, program, messageId);
      } else if (result !== 'ALREADY_RESOLVED') {
        this.logger.warn(`${result}: snapshot ${messageId} lists break ${breakId} of program ${program.externalId}`);
      }
    }
  }

  private async closable(tx: Tx, view: BreakView, program: ProgramView): Promise<boolean> {
    const condition = closureCondition(view);
    switch (condition.kind) {
      case 'NONE':
        return true;
      case 'UNSATISFIABLE':
        this.logger.error(`Break ${view.id} (${view.reason}) lacks the data to check its resolution`);
        return false;
      case 'LATER_MESSAGE':
        return this.repository.laterMessageExists(tx, program.id, view.messageId, condition.types);
      case 'VERSION_ABOVE':
        return versionAbove(program, condition.field, condition.version);
      case 'REVERSAL_APPLIED':
        return this.repository.reversalApplied(tx, condition.reservationId, condition.externalRef);
      case 'CANCELLATION_REVERSED':
        return this.repository.cancellationReversedAfter(tx, condition.reservationId, view.messageId);
    }
  }

  private async closeBreak(tx: Tx, view: BreakView, program: ProgramView, messageId: string): Promise<void> {
    await this.repository.closeBreak(tx, view, messageId);
    await writeOutbox(tx, {
      type: 'PROGRAM_BREAK_RESOLVED',
      programId: program.id,
      partitionKey: program.externalId,
      correlationId: messageId,
      occurredAt: this.clock.now(),
      data: {
        breakId: view.id,
        programId: program.externalId,
        reservationId: view.reservationId,
        reason: view.reason,
        blocking: view.blocking,
        resolutionMessageId: messageId,
      },
    });
  }

  private async applyInvoice(
    tx: Tx,
    context: Context,
    command: InvoiceCommand,
    program: ProgramView,
    found: ReservationView | undefined,
  ): Promise<Decision> {
    const { envelope, coordinates } = context;
    const own = found && found.programId === program.id ? await this.repository.lockReservation(tx, found.id) : undefined;
    const reservation = own ?? found;
    const facts = own ? await this.invoiceFacts(tx, command, own) : {};
    const plan = decideInvoiceCommand(command, program.id, reservation, facts);

    if (plan.outcome === 'AWAIT_RATE') {
      return this.park(tx, context, command, program, own!.id, 'FX_RATE', plan.rateId);
    }
    this.metrics.decided(command.type, plan.outcome);

    const references: Record<string, string> = reservation ? { reservationId: reservation.id } : {};
    const inbox = (outcome: 'APPLIED' | 'STALE' | 'REJECTED', reason: string | null = null) =>
      this.repository.insertInbox(tx, envelope, coordinates, {
        type: command.type,
        outcome,
        reason,
        programId: program.id,
        programExternalId: command.programId,
      });

    if (plan.outcome === 'REJECTED') {
      await inbox('REJECTED', plan.reason);
      if (plan.break) {
        const target =
          plan.break.reason === 'PROGRAM_MISMATCH'
            ? await this.repository.lockProgram(tx, reservation!.programExternalId)
            : program;
        references.breakId = await this.openBreak(tx, plan.break, target!, target!.externalId, envelope.messageId);
      }
      await this.status(tx, context, program, 'RJCT', { reason: plan.reason, references });
      return {};
    }

    if (plan.outcome === 'STALE') {
      await inbox('STALE');
      await this.status(tx, context, program, 'ACCP', { references });
      return {};
    }

    await inbox('APPLIED');
    const effect = plan.effect;
    if (effect.kind === 'FUND') {
      await this.repository.fund(tx, own!.id, effect.fundingRef, effectiveAsOf(context), envelope.messageId);
    } else if (effect.kind === 'RETURN_FUNDING') {
      await this.repository.returnFunding(tx, own!.id, effect.fundingRef, effectiveAsOf(context), envelope.messageId);
    } else {
      references.releaseId = await this.release(tx, context, program, own!, effect);
    }
    await this.status(tx, context, program, 'ACCP', { references });
    return {};
  }

  private async invoiceFacts(tx: Tx, command: InvoiceCommand, reservation: ReservationView): Promise<InvoiceFacts> {
    const release = (externalRef: string) => this.repository.findRelease(tx, reservation.id, externalRef);
    switch (command.type) {
      case 'INVOICE_FUNDED':
      case 'INVOICE_FUNDING_RETURNED':
        return { funding: await this.repository.findFunding(tx, command.fundingRef) };
      case 'INVOICE_PAYMENT_ALLOCATED':
        return {
          sameRef: await release(command.allocationId),
          quote: command.fxRateId ? await this.repository.findQuoteByRateId(tx, command.fxRateId) : undefined,
        };
      case 'INVOICE_BALANCE_WRITTEN_OFF':
        return { sameRef: await release(command.writeOffId) };
      case 'INVOICE_FUNDING_CANCELLED':
        return { sameRef: await release(command.cancellationId) };
      case 'INVOICE_RELEASE_REVERSED':
        return { sameRef: await release(command.reversalId), target: await release(command.externalRef) };
    }
  }

  private async release(
    tx: Tx,
    context: Context,
    program: ProgramView,
    reservation: ReservationView,
    effect: Extract<InvoiceEffect, { kind: 'RELEASE' }>,
  ): Promise<string> {
    const { envelope } = context;
    const { release: row, balances, reservedDelta } = effect;
    const releaseId = await this.repository.insertRelease(tx, reservation.id, row, envelope.messageId);
    await this.repository.rebalanceReservation(tx, reservation, balances);
    const after = await this.repository.addReserved(tx, program.id, reservedDelta);
    await this.repository.insertReleaseLedger(
      tx,
      after,
      reservation.id,
      releaseId,
      row.reason === 'REVERSAL',
      reservedDelta,
      envelope.messageId,
    );

    const invoiceScale = minorUnits(reservation.originalCurrency);
    await writeOutbox(tx, {
      type: RELEASE_EVENTS[row.reason],
      programId: program.id,
      partitionKey: program.externalId,
      correlationId: envelope.messageId,
      occurredAt: this.clock.now(),
      data: {
        reservationId: reservation.id,
        invoiceId: reservation.invoiceId,
        programId: program.externalId,
        releaseId,
        externalRef: row.externalRef,
        reason: row.reason,
        reversesReleaseId: row.reversesReleaseId,
        cancellationReason: row.cancellationReason,
        writeOffReason: row.writeOffReason,
        originalAmount: formatAmount(row.originalAmount, invoiceScale),
        originalCurrency: reservation.originalCurrency,
        amount: formatCapacity(row.amount),
        currency: program.currency,
        status: balances.status,
        outstanding: formatAmount(reservation.originalAmount.minus(balances.releasedOriginalAmount), invoiceScale),
        capacityOutstanding: formatCapacity(reservation.amount.minus(balances.releasedAmount)),
        reservedAfter: formatCapacity(after.reserved),
        available: formatCapacity(capacityOf(after).available),
      },
    });
    await this.limitExcess(tx, after, balancesOf(program), envelope.messageId);
    return releaseId;
  }

  private async openBreak(
    tx: Tx,
    spec: BreakSpec | InvoiceBreak,
    program: ProgramView | undefined,
    programExternalId: string,
    messageId: string,
  ): Promise<string> {
    const opened = await this.repository.openBreak(tx, spec, program, programExternalId, messageId);
    if (opened.created) {
      await writeOutbox(tx, {
        type: 'PROGRAM_BREAK_OPENED',
        programId: program?.id ?? null,
        partitionKey: programExternalId,
        correlationId: messageId,
        occurredAt: this.clock.now(),
        data: {
          breakId: opened.id,
          programId: programExternalId,
          reservationId: 'reservationId' in spec ? spec.reservationId : null,
          reason: spec.reason,
          blocking: program ? spec.blocking : false,
          messageId,
          details: spec.details,
        },
      });
    }
    return opened.id;
  }

  private async applyRate(tx: Tx, context: Context, quote: FxRatePublished): Promise<Decision> {
    const plan = decideFxRate(
      quote,
      await this.repository.findQuoteByRateId(tx, quote.rateId),
      await this.repository.findQuoteByPairVersion(tx, quote),
    );
    this.metrics.decided(quote.type, plan.outcome);

    await this.repository.insertInbox(tx, context.envelope, context.coordinates, {
      type: quote.type,
      outcome: plan.outcome,
      reason: plan.outcome === 'REJECTED' ? plan.reason : null,
      programId: null,
      programExternalId: null,
    });

    if (plan.outcome === 'REJECTED') {
      this.logger.warn(
        `FX_RATE_CONFLICT: ${quote.rateId} (${quote.from}/${quote.to} ${quote.rateType} v${quote.version}) conflicts with ${plan.conflictsWith}`,
      );
      await this.status(tx, context, undefined, 'RJCT', {
        reason: plan.reason,
        references: { conflictsWith: plan.conflictsWith },
      });
      return {};
    }

    if (plan.outcome === 'APPLIED') {
      await this.repository.insertQuote(tx, quote, context.envelope, context.coordinates);
    }
    await this.status(tx, context, undefined, 'ACCP');
    return plan.outcome === 'APPLIED' ? { wakeRate: quote.rateId } : {};
  }

  private async answerDuplicate(tx: Tx, context: Context, program: ProgramView | undefined): Promise<Decision | undefined> {
    const { messageId } = context.envelope;
    const inbox = await this.repository.findInbox(tx, messageId);
    if (inbox) {
      await this.status(tx, context, program, inbox.outcome === 'REJECTED' ? 'RJCT' : 'ACCP', {
        reason: inbox.reason,
        force: true,
      });
      this.metrics.duplicate(inbox.outcome);
      const formal = inbox.reason === 'INVALID_FORMAT' || inbox.reason === 'UNKNOWN_MESSAGE_TYPE';
      return formal ? { deadLetter: inbox.reason! } : {};
    }

    const parked = await this.repository.findParked(tx, messageId);
    if (parked) {
      if (!parked.resolvedAt) {
        await this.status(tx, context, program, 'PDNG', {
          awaiting: { kind: parked.awaitingKind, ref: parked.awaitingRef },
        });
      }
      this.metrics.duplicate('PARKED');
      return {};
    }
    return undefined;
  }

  private async park(
    tx: Tx,
    context: Context,
    command: ProgramCommand | InvoiceCommand | BreakResolved,
    program: ProgramView | undefined,
    reservationId: string | null,
    awaitingKind: AwaitingKind,
    awaitingRef: string,
  ): Promise<Decision> {
    if (context.fromParked) {
      await this.repository.awaitAgain(tx, context.envelope.messageId, awaitingKind, awaitingRef);
    } else {
      await this.repository.insertParked(tx, {
        messageId: context.envelope.messageId,
        type: command.type,
        programId: program?.id ?? null,
        programExternalId: command.programId,
        reservationId,
        awaitingKind,
        awaitingRef,
        envelope: context.envelope,
        coordinates: context.coordinates,
      });
    }
    await this.status(tx, context, program, 'PDNG', { awaiting: { kind: awaitingKind, ref: awaitingRef } });
    this.metrics.decided(command.type, 'PARKED');
    return { wake: command.programId, parked: true };
  }

  private async apply(
    tx: Tx,
    context: Context,
    command: ProgramCommand,
    program: ProgramView | undefined,
    plan: ProgramPlan,
  ): Promise<Decision> {
    const { envelope, coordinates } = context;
    const asOf = effectiveAsOf(context);
    this.metrics.decided(command.type, plan.outcome);

    const inbox = (outcome: 'APPLIED' | 'STALE' | 'REJECTED', programId: string | null, reason: string | null = null) =>
      this.repository.insertInbox(tx, envelope, coordinates, {
        type: command.type,
        outcome,
        reason,
        programId,
        programExternalId: command.programId,
      });

    if (plan.outcome === 'REJECTED') {
      await inbox('REJECTED', program?.id ?? null, plan.reason);
      const breakId = await this.openBreak(tx, plan.break, program, command.programId, envelope.messageId);
      await this.status(tx, context, program, 'RJCT', { reason: plan.reason, references: { breakId } });
      return {};
    }

    if (plan.outcome === 'STALE') {
      await inbox('STALE', program!.id);
      await this.repository.touchSyncedAt(tx, program!.id, asOf);
      if (command.type === 'PROGRAM_SNAPSHOT') await this.resolveListedBreaks(tx, command, program!, envelope.messageId);
      await this.status(tx, context, program, 'ACCP');
      return {};
    }

    const before = program ? balancesOf(program) : undefined;
    const after =
      'create' in plan
        ? await this.repository.createProgram(tx, plan.create, asOf)
        : await this.repository.updateProgram(tx, program!, plan.changes, asOf);

    await inbox('APPLIED', after.id);
    await this.repository.insertTreasuryLedger(
      tx,
      after.id,
      plan.ledger,
      before ?? ZERO_BALANCES(after),
      balancesOf(after),
      envelope.messageId,
    );
    await this.limitExcess(tx, after, before, envelope.messageId);
    if (command.type === 'PROGRAM_SNAPSHOT') await this.resolveListedBreaks(tx, command, after, envelope.messageId);
    await this.status(tx, context, after, 'ACCP');
    return 'create' in plan ? { wake: command.programId } : {};
  }

  private async limitExcess(
    tx: Tx,
    program: ProgramView,
    before: CapacityBalances | undefined,
    messageId: string,
  ): Promise<void> {
    const was = capacityOf(before ?? ZERO_BALANCES(program)).overLimit;
    const now = capacityOf(program).overLimit;
    const started = was.isZero() && !now.isZero();
    const ended = !was.isZero() && now.isZero();
    if (!started && !ended) return;

    if (started) {
      this.logger.warn(`LIMIT_EXCESS: program ${program.externalId} is over limit by ${formatCapacity(now)}`);
    }
    await writeOutbox(tx, {
      type: started ? 'PROGRAM_LIMIT_EXCESS_STARTED' : 'PROGRAM_LIMIT_EXCESS_ENDED',
      programId: program.id,
      partitionKey: program.externalId,
      correlationId: messageId,
      occurredAt: this.clock.now(),
      data: {
        programId: program.externalId,
        overLimit: formatCapacity(now),
        currency: program.currency,
        creditLimit: formatCapacity(program.creditLimit),
        externalUtilized: formatCapacity(program.externalUtilized),
        reserved: formatCapacity(program.reserved),
        causeMessageId: messageId,
      },
    });
  }

  private async status(
    tx: Tx,
    context: Context,
    program: ProgramView | undefined,
    status: 'ACCP' | 'RJCT' | 'PDNG',
    options: {
      reason?: string | null;
      awaiting?: { kind: string; ref: string };
      references?: Record<string, string>;
      force?: boolean;
    } = {},
  ): Promise<void> {
    if (status === 'ACCP' && !this.publishAccepted && !context.fromParked && !options.force) return;
    await writeStatus(tx, {
      messageId: context.envelope.messageId,
      status,
      reason: options.reason,
      awaiting: options.awaiting,
      references: options.references,
      programId: program?.id ?? null,
      partitionKey: context.partitionKey,
      correlationId: context.envelope.messageId,
      decidedAt: this.clock.now(),
    });
  }
}