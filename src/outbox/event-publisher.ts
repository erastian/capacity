export interface OutgoingMessage {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

export abstract class EventPublisher {
  abstract publish(messages: OutgoingMessage[]): Promise<void>;
  abstract close(): Promise<void>;
}