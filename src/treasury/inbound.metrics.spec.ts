import type { ConfigService } from '@nestjs/config';
import { Registry } from 'prom-client';
import type { Env } from '../config/env.js';
import type { MetricsServer } from '../metrics/metrics.server.js';
import { InboundMetrics } from './inbound.metrics.js';

const settings: Partial<Env> = { CLOCK_SKEW_TOLERANCE_SECONDS: 300, CONSUMER_LAG_MAX_SECONDS: 300 };
const config = { get: (key: keyof Env) => settings[key] } as unknown as ConfigService<Env, true>;

describe('inbound metrics', () => {
  let registry: Registry;
  let metrics: InboundMetrics;

  beforeEach(() => {
    registry = new Registry();
    metrics = new InboundMetrics({ registry } as MetricsServer, config);
  });

  const decided = async () => (await registry.getSingleMetric('treasury_messages_total')!.get()).values;

  it('records decisions of a committed transaction', async () => {
    await metrics.afterCommit(async () => metrics.decided('LIMIT_UPDATED', 'APPLIED'));
    expect(await decided()).toEqual([expect.objectContaining({ value: 1, labels: { type: 'LIMIT_UPDATED', outcome: 'APPLIED' } })]);
  });

  it('drops decisions of a transaction that rolled back', async () => {
    await expect(
      metrics.afterCommit(async () => {
        metrics.decided('LIMIT_UPDATED', 'APPLIED');
        throw new Error('deadlock detected');
      }),
    ).rejects.toThrow('deadlock detected');
    expect(await decided()).toEqual([]);
  });

  it('labels an unknown message type as UNKNOWN', async () => {
    metrics.decided('SOMETHING_NEW', 'REJECTED');
    expect(await decided()).toEqual([expect.objectContaining({ labels: { type: 'UNKNOWN', outcome: 'REJECTED' } })]);
  });
});
