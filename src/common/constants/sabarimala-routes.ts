/**
 * Authoritative Sabarimala Darshan Route module.
 *
 * This is the SINGLE SOURCE OF TRUTH for Sabarimala Darshan route identifiers,
 * official portal labels, recognized aliases, normalisation, and route comparison.
 *
 * The official Sabarimala booking portal recognizes exactly 3 Darshan trekking routes:
 * 1. Pamba - Marakkoottam - 4 Kms (Official Dropdown Value: "1")
 * 2. Erumely - Kalaketti Traditional Path - 46 Kms (Official Dropdown Value: "2")
 * 3. Vandiperiyar - Sathram - Pulmedu - 16 Kms (Official Dropdown Value: "3")
 *
 * Nilakkal Shuttle:
 * Nilakkal is a vehicular transit hub 18 Kms prior to Pamba base where KSRTC operates
 * chain shuttle buses to Pamba. It is NOT a Darshan Virtual-Q pilgrimage trekking route on
 * the official portal. Darshan Virtual-Q passes are only issued from Pamba, Erumely, or
 * Vandiperiyar. Any attempt to book "Nilakkal Shuttle" or other unsupported routes for
 * Darshan Virtual-Q is explicitly identified as UNSUPPORTED.
 */

export enum SabarimalaRoute {
  PAMBA = 'PAMBA',
  ERUMELY = 'ERUMELY',
  VANDIPERIYAR = 'VANDIPERIYAR',
}

export interface RouteDefinition {
  canonicalCode: SabarimalaRoute;
  officialValue: string; // "1", "2", "3" on official portal
  officialLabel: string;
  primaryKeyword: string;
  aliases: string[];
}

export const SABARIMALA_ROUTE_DEFINITIONS: Record<SabarimalaRoute, RouteDefinition> = {
  [SabarimalaRoute.PAMBA]: {
    canonicalCode: SabarimalaRoute.PAMBA,
    officialValue: '1',
    officialLabel: 'Pamba - Marakkoottam - 4 Kms',
    primaryKeyword: 'pamba',
    aliases: [
      'pamba',
      'pamba base',
      'pamba (regular footpath route)',
      'pamba regular footpath route',
      'regular footpath route',
      'pamba - marakkoottam - 4 kms',
      'pamba marakkoottam 4 kms',
      'marakkoottam',
      'marakkootam',
      'pampa',
    ],
  },
  [SabarimalaRoute.ERUMELY]: {
    canonicalCode: SabarimalaRoute.ERUMELY,
    officialValue: '2',
    officialLabel: 'Erumely - Kalaketti Traditional Path - 46 Kms',
    primaryKeyword: 'erumely',
    aliases: [
      'erumely',
      'erumeli',
      'erumeli traditional',
      'erumely traditional',
      'erumeli (perur thodu - kalaketty traditional)',
      'erumely (perur thodu - kalaketty traditional)',
      'erumely - kalaketti traditional path - 46 kms',
      'kalaketti',
      'kalaketty',
      'perur thodu',
      'traditional path',
      'traditional route',
      'erumely traditional path',
      'erumeli traditional path',
    ],
  },
  [SabarimalaRoute.VANDIPERIYAR]: {
    canonicalCode: SabarimalaRoute.VANDIPERIYAR,
    officialValue: '3',
    officialLabel: 'Vandiperiyar - Sathram - Pulmedu - 16 Kms',
    primaryKeyword: 'vandiperiyar',
    aliases: [
      'vandiperiyar',
      'vandi periyar',
      'vandiperiyar / pulmedu',
      'vandiperiyar pulmedu',
      'vandiperiyar (sathram - pulmedu forest route)',
      'sathram',
      'pulmedu',
      'pulmedu forest route',
      'vandiperiyar - sathram - pulmedu - 16 kms',
      'sathram pulmedu',
    ],
  },
};

/**
 * Normalizes any input route string into its authoritative SabarimalaRoute canonical enum.
 *
 * Rules:
 * - Case-insensitive and trimmed.
 * - Supports Erumeli / Erumely spellings and Perur Thodu / Kalaketti variations.
 * - Supports Vandiperiyar / Sathram / Pulmedu variations.
 * - Supports Pamba Base / Marakkoottam variations.
 * - NEVER defaults an unknown or unrecognised route to PAMBA.
 * - Returns null for unrecognized, empty, or unsupported routes (e.g. Nilakkal Shuttle).
 */
export function normalizeSabarimalaRoute(route?: string | null): SabarimalaRoute | null {
  if (!route || typeof route !== 'string') return null;
  const trimmed = route.trim();
  if (!trimmed) return null;

  // Check direct canonical enum matches
  const upper = trimmed.toUpperCase();
  if (upper === SabarimalaRoute.PAMBA) return SabarimalaRoute.PAMBA;
  if (upper === SabarimalaRoute.ERUMELY) return SabarimalaRoute.ERUMELY;
  if (upper === SabarimalaRoute.VANDIPERIYAR) return SabarimalaRoute.VANDIPERIYAR;

  // Normalized alphanumeric string for flexible alias matching
  const normInput = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const key of Object.keys(SABARIMALA_ROUTE_DEFINITIONS) as SabarimalaRoute[]) {
    const def = SABARIMALA_ROUTE_DEFINITIONS[key];
    const normOfficial = def.officialLabel.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normInput === normOfficial) return def.canonicalCode;

    for (const alias of def.aliases) {
      const normAlias = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normInput === normAlias) return def.canonicalCode;
    }
  }

  // Substring / keyword checks with strict priority
  const lower = trimmed.toLowerCase();

  // Erumeli / Erumely check (both 'erumeli' and 'erumely', 'kalaketti', 'kalaketty')
  if (
    lower.includes('erumely') ||
    lower.includes('erumeli') ||
    lower.includes('kalaketti') ||
    lower.includes('kalaketty')
  ) {
    return SabarimalaRoute.ERUMELY;
  }

  // Vandiperiyar / Pulmedu / Sathram check
  if (
    lower.includes('vandiperiyar') ||
    lower.includes('sathram') ||
    lower.includes('pulmedu')
  ) {
    return SabarimalaRoute.VANDIPERIYAR;
  }

  // Pamba check (ensure it is not Nilakkal Shuttle that merely mentions Pamba)
  // e.g. "Nilakkal - Pamba Shuttle Route" must NOT match PAMBA
  if (lower.includes('nilakkal')) {
    // Nilakkal is a vehicular shuttle / transport service, NOT a Darshan trekking route
    return null;
  }

  if (lower.includes('pamba') || lower.includes('marakkoottam') || lower.includes('marakkootam') || lower.includes('pampa')) {
    return SabarimalaRoute.PAMBA;
  }

  return null;
}

/**
 * Returns canonical route token string (PAMBA, ERUMELY, VANDIPERIYAR) for backward compatibility
 * or fallback formatted token if completely unknown (never defaults to PAMBA silently).
 */
export function normalizeRouteCanonical(route?: string | null): string {
  const canonical = normalizeSabarimalaRoute(route);
  if (canonical) return canonical;
  if (!route || !route.trim()) return 'ROUTE';
  return route.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 15) || 'ROUTE';
}

/**
 * Retrieves the full official Sabarimala portal label for a canonical route.
 */
export function getOfficialSabarimalaRouteLabel(route: SabarimalaRoute | string): string {
  const canonical = normalizeSabarimalaRoute(route);
  if (canonical && SABARIMALA_ROUTE_DEFINITIONS[canonical]) {
    return SABARIMALA_ROUTE_DEFINITIONS[canonical].officialLabel;
  }
  return String(route || '');
}

/**
 * Retrieves the official portal dropdown value ('1', '2', '3') for a route.
 */
export function getOfficialSabarimalaRouteValue(route: SabarimalaRoute | string): string | null {
  const canonical = normalizeSabarimalaRoute(route);
  if (canonical && SABARIMALA_ROUTE_DEFINITIONS[canonical]) {
    return SABARIMALA_ROUTE_DEFINITIONS[canonical].officialValue;
  }
  return null;
}

/**
 * Determines whether two route representations refer to the same Sabarimala route.
 * Replaces loose substring checks with authoritative canonical equivalence.
 */
export function isSameSabarimalaRoute(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const canonicalA = normalizeSabarimalaRoute(a);
  const canonicalB = normalizeSabarimalaRoute(b);
  if (canonicalA && canonicalB) {
    return canonicalA === canonicalB;
  }
  // Fallback for non-standard routes
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Compares candidate route with target route, handling portal formatting variations.
 * If targetRoute is empty or null, any candidate matches.
 */
export function isRouteMatching(candidateRoute?: string | null, targetRoute?: string | null): boolean {
  if (!targetRoute || !targetRoute.trim()) return true;
  if (!candidateRoute || !candidateRoute.trim()) return false;

  const cCanonical = normalizeSabarimalaRoute(candidateRoute);
  const tCanonical = normalizeSabarimalaRoute(targetRoute);

  if (cCanonical && tCanonical) {
    return cCanonical === tCanonical;
  }

  const c = candidateRoute.trim().toLowerCase();
  const t = targetRoute.trim().toLowerCase();
  if (c === t) return true;

  // If one resolved to a known route and the other did not, they cannot match
  if (cCanonical || tCanonical) return false;

  return c.includes(t) || t.includes(c);
}
