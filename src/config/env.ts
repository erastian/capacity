import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsTimeZone,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export class Env {
  @IsIn(NODE_ENVS)
  NODE_ENV: (typeof NODE_ENVS)[number] = 'development';

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT = 3000;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  METRICS_PORT = 9464;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info';

  @IsString()
  DATABASE_URL: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  DB_POOL_SIZE = 10;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  DB_TX_MAX_WAIT_MS = 5000;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  DB_TX_TIMEOUT_MS = 10000;

  @IsTimeZone()
  BUSINESS_TIMEZONE = 'Europe/London';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  FX_RATE_MAX_AGE_SECONDS = 6 * 60 * 60;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

  @IsUrl({ require_tld: false, require_protocol: true })
  AUTH_ISSUER: string;

  @IsString()
  @IsNotEmpty()
  AUTH_AUDIENCE: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  AUTH_JWKS_URL: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  AUTH_CLOCK_TOLERANCE_SECONDS = 30;
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw);
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return env;
}