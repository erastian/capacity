import { AppError } from '../errors/app-error.js';
import { CURSOR_PART, decodeCursor, encodeCursor, toPage } from './pagination.js';

const KEY = ['2026-10-14T10:00:00.000Z', '7f1c0a52-3b9e-4c1d-9a0e-2f6b8d4e5a10'];
const PARTS = [CURSOR_PART.instant, CURSOR_PART.uuid];

describe('cursor', () => {
  it('round-trips a key', () => {
    expect(decodeCursor(encodeCursor(KEY), PARTS)).toEqual(KEY);
  });

  it('means the first page when absent', () => {
    expect(decodeCursor(undefined, PARTS)).toBeUndefined();
  });

  it.each([
    ['not base64 JSON', 'bm9wZQ'],
    ['a key of another shape', encodeCursor([KEY[0]!])],
    ['a part that would break the query', encodeCursor([KEY[0]!, 'not-a-uuid'])],
  ])('rejects %s as a validation error', (_, cursor) => {
    expect(() => decodeCursor(cursor, PARTS)).toThrow(AppError);
  });
});

describe('toPage', () => {
  const rows = [1, 2, 3];

  it('returns a cursor only when a row beyond the limit exists', () => {
    expect(toPage(rows, 2, (row) => [String(row)], (row) => row)).toEqual({ items: [1, 2], nextCursor: encodeCursor(['2']) });
    expect(toPage(rows, 3, (row) => [String(row)], (row) => row)).toEqual({ items: [1, 2, 3], nextCursor: null });
  });
});