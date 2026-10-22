import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimiterGuard } from './rate-limiter.guard';

describe('Phase 4: RateLimiterGuard Sliding Window Suite', () => {
  let guard: RateLimiterGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    RateLimiterGuard.clearStore();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimiterGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
      ],
    }).compile();

    guard = module.get<RateLimiterGuard>(RateLimiterGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  const createMockContext = (ip = '192.168.1.100', path = '/auth/login', method = 'POST') => {
    const headers: Record<string, string> = {};
    const responseHeaders: Record<string, string> = {};

    const request = {
      ip,
      path,
      method,
      headers,
    };

    const response = {
      setHeader: jest.fn((k: string, v: string) => {
        responseHeaders[k] = v;
      }),
      getHeader: (k: string) => responseHeaders[k],
    };

    return {
      context: {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext,
      response,
      responseHeaders,
    };
  };

  it('allows requests within the throttle limit and sets rate limit response headers', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({ limit: 3, ttlSeconds: 60 });

    const { context, response } = createMockContext('1.2.3.4', '/auth/login');

    expect(guard.canActivate(context)).toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '3');
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '2');

    expect(guard.canActivate(context)).toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '1');

    expect(guard.canActivate(context)).toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
  });

  it('throws 429 Too Many Requests when request count exceeds limit', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({ limit: 2, ttlSeconds: 60 });

    const { context, response } = createMockContext('1.2.3.5', '/auth/login');

    guard.canActivate(context); // Hit 1
    guard.canActivate(context); // Hit 2

    // Hit 3 exceeds limit of 2
    let thrownError: any;
    try {
      guard.canActivate(context);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(HttpException);
    expect(thrownError.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(thrownError.getResponse()).toEqual(
      expect.objectContaining({
        statusCode: 429,
        error: 'Too Many Requests',
      })
    );

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
  });

  it('tracks distinct IP addresses independently', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({ limit: 1, ttlSeconds: 60 });

    const { context: contextA } = createMockContext('10.0.0.1', '/auth/login');
    const { context: contextB } = createMockContext('10.0.0.2', '/auth/login');

    expect(guard.canActivate(contextA)).toBe(true);
    expect(() => guard.canActivate(contextA)).toThrow(HttpException);

    // Context B with distinct IP is permitted
    expect(guard.canActivate(contextB)).toBe(true);
  });
});
