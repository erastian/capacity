import { EventPublisher } from '../../src/outbox/event-publisher.js';
import type { OutgoingMessage } from '../../src/outbox/outbox.types.js';

export class CapturingPublisher extends EventPublisher {
  readonly sent: OutgoingMessage[] = [];

  async publish(messages: OutgoingMessage[]): Promise<void> {
    this.sent.push(...messages);
  }

  async close(): Promise<void> {}
}
