import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';
import type { Clock } from '../shared/time/clock.js';
import type { RawMessage } from './adapter/envelope.types.js';
import type { InboundMetrics } from './inbound.metrics.js';
import type { InboundProcessor } from './inbound.processor.js';
import { TreasuryConsumer } from './treasury.consumer.js';

const raw: RawMessage = {
  topic: 'treasury.program-capacity',
  partition: 0,
  offset: 1n,
  key: 'P-1',
  value: '{}',
  timestamp: new Date(),
};

const settings: Partial<Env> = { TREASURY_CONSUMER_ENABLED: false, PARKED_SWEEP_INTERVAL_MS: 60_000, INBOUND_MAX_ATTEMPTS: 2 };
const config = { get: (key: keyof Env) => settings[key] } as unknown as ConfigService<Env, true>;
const metrics = { failed: vi.fn(), received: vi.fn(), consuming: vi.fn() } as unknown as InboundMetrics;
const clock = { now: () => new Date() } as unknown as Clock;

const lostConnection = () => new Error('Connection terminated unexpectedly');
const dataError = () =>
  new Prisma.PrismaClientKnownRequestError('numeric field overflow', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: '22003' } } },
  });

function consumerWith(processor: Partial<Record<'process' | 'rejectPoison', ReturnType<typeof vi.fn>>>) {
  const fake = { process: vi.fn(), rejectPoison: vi.fn(), ...processor };
  const consumer = new TreasuryConsumer(fake as unknown as InboundProcessor, metrics, clock, config);
  return { consumer, fake, handle: () => consumer['handle'](raw) };
}

describe('treasury consumer', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('retries a transient failure until the message goes through', async () => {
    const { fake, handle } = consumerWith({
      process: vi.fn().mockRejectedValueOnce(lostConnection()).mockResolvedValueOnce(undefined),
    });
    expect(await handle()).toBe(true);
    expect(fake.process).toHaveBeenCalledTimes(2);
    expect(fake.rejectPoison).not.toHaveBeenCalled();
  });

  it('rejects a data error at once', async () => {
    const { fake, handle } = consumerWith({ process: vi.fn().mockRejectedValue(dataError()) });
    expect(await handle()).toBe(true);
    expect(fake.process).toHaveBeenCalledTimes(1);
    expect(fake.rejectPoison).toHaveBeenCalledTimes(1);
  });

  it('rejects any other error once the attempts run out', async () => {
    const { fake, handle } = consumerWith({ process: vi.fn().mockRejectedValue(new Error('[DecimalError] Invalid argument')) });
    expect(await handle()).toBe(true);
    expect(fake.process).toHaveBeenCalledTimes(2);
    expect(fake.rejectPoison).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying when the rejection itself cannot be recorded', async () => {
    const { fake, handle } = consumerWith({
      process: vi.fn().mockRejectedValue(dataError()),
      rejectPoison: vi.fn().mockRejectedValueOnce(lostConnection()).mockResolvedValueOnce(undefined),
    });
    expect(await handle()).toBe(true);
    expect(fake.rejectPoison).toHaveBeenCalledTimes(2);
  });

  it('stops retrying at shutdown without waiting out the backoff', async () => {
    const { consumer, handle } = consumerWith({ process: vi.fn().mockRejectedValue(lostConnection()) });
    const handled = handle();
    await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    await consumer.beforeApplicationShutdown();
    expect(await handled).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
