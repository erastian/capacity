export interface AppErrorOptions {
  detail?: string;
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class AppError extends Error {
  readonly detail?: string;
  readonly extensions: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    readonly status: number,
    readonly code: string,
    options: AppErrorOptions = {},
  ) {
    super(options.detail ?? code);
    this.name = 'AppError';
    this.detail = options.detail;
    this.extensions = options.extensions ?? {};
    this.headers = options.headers ?? {};
  }
}