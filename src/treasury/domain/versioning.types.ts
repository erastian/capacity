export type FieldDecision = 'apply' | 'stale' | 'conflict';

export interface Versioned<T> {
  value: T;
  version: bigint | null;
}