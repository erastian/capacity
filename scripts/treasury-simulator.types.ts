export interface SimulatorConfig {
  apiUrl: string;
  tokenUrl: string;
  originationClient: { id: string; secret: string };
  auditor: { username: string; password: string };
  brokers: string;
  treasury: { username: string; password: string };
}

export interface Money {
  amount: string;
  currency: string;
}

export interface ProgramMessage {
  type: string;
  programId?: string;
  batchId?: string;
  version?: number;
  payload: Record<string, unknown>;
}

export interface Quote {
  rateId: string;
  from: string;
  to: string;
  rateType: 'VALUATION' | 'CONVERSION';
  status?: 'ACTIVE' | 'SUSPENDED';
  rate?: string;
}

export interface Reservation {
  id: string;
  invoiceId: string;
  status: number;
  body: Record<string, unknown>;
}

export interface Scenario {
  description: string;
  run: (world: World) => Promise<void>;
}

export interface World {
  programId: string;
  log: (line: string) => void;
  sendProgram: (message: ProgramMessage) => Promise<string>;
  sendQuote: (quote: Quote) => Promise<string>;
  reserve: (invoice: Money & { dueDate?: string; programId?: string }) => Promise<Reservation>;
  settle: () => Promise<void>;
  show: (programId?: string) => Promise<void>;
  showRates: () => Promise<void>;
  openBreaks: () => Promise<string[]>;
  unique: (prefix: string) => string;
}