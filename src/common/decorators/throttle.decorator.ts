import { SetMetadata } from '@nestjs/common';

export const THROTTLE_KEY = 'rate_limit_throttle';

export interface ThrottleOptions {
  limit: number;
  ttlSeconds: number;
}

/**
 * Configure rate limit for a specific controller or route handler.
 * @param limit Maximum allowed requests within the time window
 * @param ttlSeconds Time window in seconds (default: 60s)
 */
export const Throttle = (limit: number, ttlSeconds: number = 60) =>
  SetMetadata(THROTTLE_KEY, { limit, ttlSeconds });
