export type Numeric = { toString(): string };

export interface DriverAdapterMeta {
  driverAdapterError?: { cause?: { originalCode?: unknown } };
}