import { HttpStatus } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, isUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { AppError } from '../errors/app-error.js';
import type { Page } from './pagination.types.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor must be a cursor returned by a previous page' })
  cursor?: string;
}

function invalidCursor(): AppError {
  return new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', {
    detail: 'Request validation failed',
    extensions: { errors: [{ field: 'cursor', messages: ['cursor must be a cursor returned by a previous page'] }] },
  });
}

export function encodeCursor(key: readonly string[]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

const MAX_BIGINT = 2n ** 63n - 1n;

export const CURSOR_PART = {
  uuid: (value: string) => isUUID(value),
  instant: (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.toISOString() === value;
  },
  text: (value: string) => value.length > 0 && value.length <= 256 && !value.includes('\0'),
  integer: (value: string) => /^\d{1,19}$/.test(value) && BigInt(value) <= MAX_BIGINT,
} as const;

export function decodeCursor(
  cursor: string | undefined,
  parts: readonly ((value: string) => boolean)[],
): string[] | undefined {
  if (cursor === undefined) return undefined;
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const valid =
    Array.isArray(key) &&
    key.length === parts.length &&
    key.every((part, index) => typeof part === 'string' && parts[index]!(part));
  if (!valid) throw invalidCursor();
  return key as string[];
}

export function toPage<Row, Item>(
  rows: Row[],
  limit: number,
  keyOf: (row: Row) => string[],
  view: (row: Row) => Item,
): Page<Item> {
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    items: visible.map(view),
    nextCursor: rows.length > limit && last ? encodeCursor(keyOf(last)) : null,
  };
}