import { IsISO8601, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { IDENTIFIER } from '../shared/domain/identifier.js';
import { PageQuery } from '../shared/http/pagination.js';
import { ISO_INSTANT } from '../shared/time/instant.js';
import { BooleanFlag } from '../shared/validation/boolean-flag.js';

const CODE = /^[A-Z_]{1,64}$/;
const IDENTIFIER_MESSAGE = { message: '$property must be 1-128 characters of [A-Za-z0-9._:/-]' };
const CODE_MESSAGE = { message: '$property must be an upper-case code' };
const INSTANT_MESSAGE = { message: '$property must be a date-time with a time zone, e.g. 2026-01-31T00:00:00Z' };

export class BreaksQuery extends PageQuery {
  @IsOptional()
  @Matches(IDENTIFIER, IDENTIFIER_MESSAGE)
  programId?: string;

  @IsOptional()
  @BooleanFlag()
  open?: boolean;

  @IsOptional()
  @Matches(CODE, CODE_MESSAGE)
  reason?: string;
}

export class ProgramBreaksQuery extends PageQuery {
  @IsOptional()
  @BooleanFlag()
  open?: boolean;

  @IsOptional()
  @Matches(CODE, CODE_MESSAGE)
  reason?: string;
}

export class LedgerQuery extends PageQuery {
  @Matches(IDENTIFIER, IDENTIFIER_MESSAGE)
  programId: string;
}

export class InboxQuery extends PageQuery {
  @IsOptional()
  @Matches(IDENTIFIER, IDENTIFIER_MESSAGE)
  programId?: string;

  @IsOptional()
  @Matches(IDENTIFIER, IDENTIFIER_MESSAGE)
  messageId?: string;

  @IsOptional()
  @IsIn(['APPLIED', 'STALE', 'REJECTED'])
  outcome?: string;

  @IsOptional()
  @Matches(CODE, CODE_MESSAGE)
  type?: string;
}

export class ParkedQuery extends PageQuery {
  @IsOptional()
  @Matches(IDENTIFIER, IDENTIFIER_MESSAGE)
  programId?: string;

  @IsOptional()
  @BooleanFlag()
  unresolved?: boolean;
}

export class FundingsQuery extends PageQuery {
  @IsUUID()
  reservationId: string;
}

export class OutboxQuery extends PageQuery {
  @IsOptional()
  @BooleanFlag()
  unpublished?: boolean;

  @IsOptional()
  @Matches(IDENTIFIER, IDENTIFIER_MESSAGE)
  programId?: string;

  @IsOptional()
  @Matches(CODE, CODE_MESSAGE)
  type?: string;
}

export class DeclineJournalQuery extends PageQuery {
  @IsOptional()
  @Matches(IDENTIFIER, IDENTIFIER_MESSAGE)
  programId?: string;

  @IsOptional()
  @Matches(CODE, CODE_MESSAGE)
  code?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ISO_INSTANT, INSTANT_MESSAGE)
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ISO_INSTANT, INSTANT_MESSAGE)
  to?: string;
}
