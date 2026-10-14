import type { Env } from '../../config/env.js';

export interface KafkaConnection {
  clientId: string;
  bootstrapBrokers: string[];
  sasl: {
    mechanism: Env['KAFKA_SASL_MECHANISM'];
    username: string;
    password: string;
  };
}
