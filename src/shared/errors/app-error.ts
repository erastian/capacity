export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? code);
    this.name = 'AppError';
  }
}