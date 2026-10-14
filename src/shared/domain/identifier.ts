export const IDENTIFIER = /^[A-Za-z0-9._:/-]{1,128}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}