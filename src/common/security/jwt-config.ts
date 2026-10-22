import { Logger } from '@nestjs/common';

const logger = new Logger('JwtConfig');

const MIN_SECRET_LENGTH = 32;

const INSECURE_FALLBACKS = [
  'super_secret_ticketassist_jwt_key_yuktron_2026',
  'ticketassist-dev-super-secret-jwt-key-32chars',
  'ticketassist-dev-secret-2026',
  'replace_with_secure_random_64_char_hex_jwt_secret_key',
  'secret',
  'jwt_secret',
  'changeme',
];

/**
 * Returns the validated JWT Secret from environment variables.
 * Enforces a minimum length of 32 characters (256-bit entropy) for symmetric HMAC-SHA256.
 * Fails closed on startup if secret is missing, empty, or too short.
 * Never prints or leaks secret content in logs or error messages.
 */
export function getValidatedJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.trim().length === 0) {
    throw new Error(
      'FATAL: JWT_SECRET environment variable is missing or empty. ' +
        `A cryptographically secure secret of at least ${MIN_SECRET_LENGTH} characters (256-bit entropy) is required for symmetric HMAC-SHA256 signing. Startup aborted.`
    );
  }

  const cleanSecret = secret.trim();

  if (cleanSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `FATAL: JWT_SECRET environment variable is too short (${cleanSecret.length} characters). ` +
        `Minimum ${MIN_SECRET_LENGTH} characters required for secure HMAC-SHA256 signing. Startup aborted.`
    );
  }

  if (process.env.NODE_ENV === 'production' && INSECURE_FALLBACKS.includes(cleanSecret.toLowerCase())) {
    throw new Error(
      'FATAL: JWT_SECRET is configured with a known insecure/placeholder default secret in production environment. ' +
        'A unique, high-entropy secret must be provided via environment variables. Startup aborted.'
    );
  }

  return cleanSecret;
}

/**
 * Utility to test whether a JWT secret is properly configured without throwing.
 */
export function isJwtSecretValid(secretCandidate?: string): boolean {
  if (!secretCandidate) return false;
  const clean = secretCandidate.trim();
  return clean.length >= MIN_SECRET_LENGTH;
}
