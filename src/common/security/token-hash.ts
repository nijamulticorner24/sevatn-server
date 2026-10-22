import * as crypto from 'crypto';

/**
 * Computes a SHA-256 hash of a raw token for secure verifier storage in the database.
 * Storing only the SHA-256 hash verifier ensures that even in the event of an unauthorized
 * database export or backup leak, active worker machine credentials cannot be replayed.
 */
export function hashMachineToken(rawToken: string): string {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    throw new Error('Machine token must be a non-empty string');
  }
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
}
