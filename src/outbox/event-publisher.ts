import type { OutgoingMessage } from './outbox.types.js';

export abstract class EventPublisher {
  abstract publish(messages: OutgoingMessage[]): Promise<void>;
  abstract close(): Promise<void>;
}