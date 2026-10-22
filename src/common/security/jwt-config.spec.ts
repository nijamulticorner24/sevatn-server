import { getValidatedJwtSecret, isJwtSecretValid } from './jwt-config';

describe('JWT Secret Security & Policy Enforcer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('fails startup when JWT_SECRET is undefined', () => {
    delete process.env.JWT_SECRET;
    expect(() => getValidatedJwtSecret()).toThrow(
      /FATAL: JWT_SECRET environment variable is missing or empty/
    );
  });

  it('fails startup when JWT_SECRET is empty string or only whitespace', () => {
    process.env.JWT_SECRET = '   ';
    expect(() => getValidatedJwtSecret()).toThrow(
      /FATAL: JWT_SECRET environment variable is missing or empty/
    );
  });

  it('fails startup when JWT_SECRET has fewer than 32 characters (e.g. 16 chars)', () => {
    process.env.JWT_SECRET = 'short_secret_key_16_chars!';
    expect(() => getValidatedJwtSecret()).toThrow(
      /FATAL: JWT_SECRET environment variable is too short \(26 characters\)\. Minimum 32 characters required/
    );
  });

  it('fails startup in production if JWT_SECRET is a known insecure placeholder', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'super_secret_ticketassist_jwt_key_yuktron_2026';
    expect(() => getValidatedJwtSecret()).toThrow(
      /FATAL: JWT_SECRET is configured with a known insecure\/placeholder default secret in production environment/
    );
  });

  it('succeeds when a cryptographically secure 32+ character secret is provided', () => {
    const validSecret = 'ba953ffd564d5ebb54fa35fea819678f3f1a6d6eaa6e566080d943d17dba154f';
    process.env.JWT_SECRET = validSecret;
    const resolved = getValidatedJwtSecret();
    expect(resolved).toBe(validSecret);
    expect(resolved.length).toBeGreaterThanOrEqual(32);
  });

  it('isJwtSecretValid returns false for invalid candidates and true for valid ones', () => {
    expect(isJwtSecretValid(undefined)).toBe(false);
    expect(isJwtSecretValid('')).toBe(false);
    expect(isJwtSecretValid('too-short')).toBe(false);
    expect(isJwtSecretValid('a'.repeat(31))).toBe(false);
    expect(isJwtSecretValid('a'.repeat(32))).toBe(true);
    expect(isJwtSecretValid('a'.repeat(64))).toBe(true);
  });

  it('error messages never leak secret content', () => {
    const sensitiveCandidate = 'secret_password_do_not_leak_123';
    process.env.JWT_SECRET = sensitiveCandidate;
    try {
      getValidatedJwtSecret();
    } catch (err: any) {
      expect(err.message).not.toContain(sensitiveCandidate);
    }
  });
});
