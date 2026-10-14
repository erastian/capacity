import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import './connection-guard.js';
import type { KafkaConnection } from './kafka.types.js';

export const Topic = {
  ProgramCapacity: 'treasury.program-capacity',
  FxRates: 'treasury.fx-rates',
  ReservationEvents: 'capacity.reservation-events',
  MessageStatus: 'capacity.message-status',
  DeadLetter: 'capacity.dlq',
} as const;

export function kafkaConnection(config: ConfigService<Env, true>): KafkaConnection {
  return {
    clientId: config.get('KAFKA_CLIENT_ID', { infer: true }),
    bootstrapBrokers: config
      .get('KAFKA_BROKERS', { infer: true })
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean),
    sasl: {
      mechanism: config.get('KAFKA_SASL_MECHANISM', { infer: true }),
      username: config.get('KAFKA_SASL_USERNAME', { infer: true }),
      password: config.get('KAFKA_SASL_PASSWORD', { infer: true }),
    },
  };
}
