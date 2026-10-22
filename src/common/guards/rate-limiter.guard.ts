import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { THROTTLE_KEY, ThrottleOptions } from '../decorators/throttle.decorator';

interface SlidingWindowRecord {
  timestamps: number[];
}

/**
 * Distributed / Resilient Sliding Window Rate Limiter Guard.
 * Tracks requests per IP / Client context.
 * Protects authentication, registration, topup, worker pairing, and sensitive endpoints
 * against brute-force, denial-of-service, and resource exhaustion attacks.
 */
@Injectable()
export class RateLimiterGuard implements CanActivate {
  private readonly logger = new Logger(RateLimiterGuard.name);
  private static readonly memoryStore = new Map<string, SlidingWindowRecord>();

  // Default rate limits if not decorated explicitly
  private static readonly DEFAULT_LIMIT = 120;
  private static readonly DEFAULT_TTL_SECONDS = 60;

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Skip rate limiting for worker internal machines and health checks
    if (request.path === '/api/docs' || request.path === '/favicon.ico') {
      return true;
    }

    const throttleConfig = this.reflector.getAllAndOverride<ThrottleOptions>(
      THROTTLE_KEY,
      [context.getHandler(), context.getClass()]
    ) || {
      limit: RateLimiterGuard.DEFAULT_LIMIT,
      ttlSeconds: RateLimiterGuard.DEFAULT_TTL_SECONDS,
    };

    const { limit, ttlSeconds } = throttleConfig;
    const now = Date.now();
    const windowStart = now - ttlSeconds * 1000;

    // Identify client identifier (IP + Authenticated User ID if present)
    const clientIp = this.getClientIp(request);
    const actorId = request.user?.id || '';
    const routeIdentifier = `${request.method}:${request.baseUrl || ''}${request.path}`;
    const storageKey = `rate:${clientIp}:${actorId}:${routeIdentifier}`;

    let record = RateLimiterGuard.memoryStore.get(storageKey);
    if (!record) {
      record = { timestamps: [] };
      RateLimiterGuard.memoryStore.set(storageKey, record);
    }

    // Filter out timestamps outside current sliding window
    record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

    if (record.timestamps.length >= limit) {
      const oldestInWindow = record.timestamps[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + ttlSeconds * 1000 - now) / 1000));

      this.logger.warn(
        `[RATE_LIMIT_EXCEEDED] Client ${clientIp} exceeded ${limit} reqs/${ttlSeconds}s on ${routeIdentifier}`
      );

      if (response && typeof response.setHeader === 'function') {
        response.setHeader('Retry-After', retryAfterSeconds.toString());
        response.setHeader('X-RateLimit-Limit', limit.toString());
        response.setHeader('X-RateLimit-Remaining', '0');
      }

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `Too many requests on this endpoint. Maximum permitted: ${limit} requests per ${ttlSeconds} seconds. Please retry after ${retryAfterSeconds} seconds.`,
          retryAfter: retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    // Record this hit
    record.timestamps.push(now);
    const remaining = Math.max(0, limit - record.timestamps.length);

    if (response && typeof response.setHeader === 'function') {
      response.setHeader('X-RateLimit-Limit', limit.toString());
      response.setHeader('X-RateLimit-Remaining', remaining.toString());
    }

    // Periodically prune stale keys from memory store
    if (RateLimiterGuard.memoryStore.size > 10000) {
      RateLimiterGuard.pruneStaleRecords(windowStart);
    }

    return true;
  }

  private getClientIp(req: any): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = String(forwarded).split(',').map((ip) => ip.trim());
      if (ips.length > 0 && ips[0]) return ips[0];
    }
    return req.ip || req.connection?.remoteAddress || '127.0.0.1';
  }

  private static pruneStaleRecords(cutoff: number): void {
    for (const [key, record] of RateLimiterGuard.memoryStore.entries()) {
      record.timestamps = record.timestamps.filter((ts) => ts > cutoff);
      if (record.timestamps.length === 0) {
        RateLimiterGuard.memoryStore.delete(key);
      }
    }
  }

  /**
   * Reset helper for testing environments
   */
  public static clearStore(): void {
    RateLimiterGuard.memoryStore.clear();
  }
}
