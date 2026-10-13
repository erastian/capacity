import { validateEnv } from './env.js';

const VALID = { DATABASE_URL: 'postgresql://u:p@localhost/db' };

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv(VALID)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      METRICS_PORT: 9464,
      LOG_LEVEL: 'info',
    });
  });

  it('converts numeric strings', () => {
    expect(validateEnv({ ...VALID, PORT: '8080', METRICS_PORT: '0' })).toMatchObject({
      PORT: 8080,
      METRICS_PORT: 0,
    });
  });

  it('fails without DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
  ])('fails on invalid %s=%s', (key, value) => {
    expect(() => validateEnv({ ...VALID, [key]: value })).toThrow(key);
  });
});