export interface AppErrorOptions {
  detail?: string;
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance: string;
  correlationId: string;
  [extension: string]: unknown;
}

export interface ProblemInput {
  status: number;
  code: string;
  detail?: string;
  extensions?: Record<string, unknown>;
  instance: string;
  correlationId: string;
}

export interface FieldError {
  field: string;
  messages: string[];
}