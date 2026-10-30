/**
 * Normalizes a target date, route, and criteria into an authoritative discovery demand key.
 * Format: YYYY-MM-DD:ROUTE_CANONICAL (e.g. 2026-11-27:PAMBA)
 */
export function normalizeDemandKey(date: string | Date, route: string, criteria?: string): string {
  const dateStr = typeof date === 'string'
    ? date.trim().split('T')[0]
    : date.toISOString().split('T')[0];

  const lowerRoute = (route || '').toLowerCase();
  let routeCanonical = 'PAMBA';
  if (lowerRoute.includes('erumely')) {
    routeCanonical = 'ERUMELY';
  } else if (lowerRoute.includes('vandiperiyar') || lowerRoute.includes('sathram')) {
    routeCanonical = 'VANDIPERIYAR';
  } else if (lowerRoute.includes('pamba')) {
    routeCanonical = 'PAMBA';
  } else {
    routeCanonical = route.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 15) || 'ROUTE';
  }

  const baseKey = `${dateStr}:${routeCanonical}`;
  if (criteria && criteria.trim()) {
    return `${baseKey}:${criteria.trim().toUpperCase()}`;
  }
  return baseKey;
}

