import { normalizeRouteCanonical } from '../constants/sabarimala-routes';

/**
 * Normalizes a target date, route, and criteria into an authoritative discovery demand key.
 * Format: YYYY-MM-DD:ROUTE_CANONICAL (e.g. 2026-11-27:PAMBA)
 */
export function normalizeDemandKey(date: string | Date, route: string, criteria?: string): string {
  const dateStr = typeof date === 'string'
    ? date.trim().split('T')[0]
    : date.toISOString().split('T')[0];

  const routeCanonical = normalizeRouteCanonical(route);

  const baseKey = `${dateStr}:${routeCanonical}`;
  if (criteria && criteria.trim()) {
    return `${baseKey}:${criteria.trim().toUpperCase()}`;
  }
  return baseKey;
}

