import {
  SabarimalaRoute,
  normalizeSabarimalaRoute,
  normalizeRouteCanonical,
  getOfficialSabarimalaRouteLabel,
  getOfficialSabarimalaRouteValue,
  isSameSabarimalaRoute,
  isRouteMatching,
  SABARIMALA_ROUTE_DEFINITIONS,
} from './sabarimala-routes';
import { normalizeDemandKey } from '../utils/demand-key';

describe('SabarimalaRoute Authoritative Normalisation and Matching', () => {
  describe('1. normalizeSabarimalaRoute', () => {
    it('normalizes Erumeli Traditional variants to ERUMELY', () => {
      expect(normalizeSabarimalaRoute('Erumeli Traditional')).toBe(SabarimalaRoute.ERUMELY);
      expect(normalizeSabarimalaRoute('Erumely Traditional')).toBe(SabarimalaRoute.ERUMELY);
      expect(normalizeSabarimalaRoute('Erumely - Kalaketti Traditional Path - 46 Kms')).toBe(SabarimalaRoute.ERUMELY);
      expect(normalizeSabarimalaRoute('Erumeli (Perur Thodu - Kalaketty Traditional)')).toBe(SabarimalaRoute.ERUMELY);
      expect(normalizeSabarimalaRoute('erumely')).toBe(SabarimalaRoute.ERUMELY);
      expect(normalizeSabarimalaRoute('ERUMELI')).toBe(SabarimalaRoute.ERUMELY);
      expect(normalizeSabarimalaRoute('Kalaketti')).toBe(SabarimalaRoute.ERUMELY);
    });

    it('normalizes Vandiperiyar / Pulmedu variants to VANDIPERIYAR', () => {
      expect(normalizeSabarimalaRoute('Vandiperiyar / Pulmedu')).toBe(SabarimalaRoute.VANDIPERIYAR);
      expect(normalizeSabarimalaRoute('Vandiperiyar - Sathram - Pulmedu - 16 Kms')).toBe(SabarimalaRoute.VANDIPERIYAR);
      expect(normalizeSabarimalaRoute('Vandiperiyar (Sathram - Pulmedu Forest Route)')).toBe(SabarimalaRoute.VANDIPERIYAR);
      expect(normalizeSabarimalaRoute('vandiperiyar')).toBe(SabarimalaRoute.VANDIPERIYAR);
      expect(normalizeSabarimalaRoute('SATHRAM')).toBe(SabarimalaRoute.VANDIPERIYAR);
      expect(normalizeSabarimalaRoute('pulmedu')).toBe(SabarimalaRoute.VANDIPERIYAR);
    });

    it('normalizes Pamba Base variants to PAMBA', () => {
      expect(normalizeSabarimalaRoute('Pamba Base')).toBe(SabarimalaRoute.PAMBA);
      expect(normalizeSabarimalaRoute('Pamba - Marakkoottam - 4 Kms')).toBe(SabarimalaRoute.PAMBA);
      expect(normalizeSabarimalaRoute('Pamba (Regular Footpath Route)')).toBe(SabarimalaRoute.PAMBA);
      expect(normalizeSabarimalaRoute('pamba')).toBe(SabarimalaRoute.PAMBA);
      expect(normalizeSabarimalaRoute('marakkoottam')).toBe(SabarimalaRoute.PAMBA);
      expect(normalizeSabarimalaRoute('PAMPA')).toBe(SabarimalaRoute.PAMBA);
    });

    it('identifies Nilakkal Shuttle as unsupported and returns null (NEVER silently maps to PAMBA)', () => {
      expect(normalizeSabarimalaRoute('Nilakkal - Pamba Shuttle Route')).toBeNull();
      expect(normalizeSabarimalaRoute('Nilakkal Shuttle')).toBeNull();
      expect(normalizeSabarimalaRoute('nilakkal')).toBeNull();
    });

    it('identifies unknown/unsupported routes and returns null (NEVER silently maps to PAMBA)', () => {
      expect(normalizeSabarimalaRoute('Unknown route')).toBeNull();
      expect(normalizeSabarimalaRoute('Kottaiyadi Traditional Trek')).toBeNull();
      expect(normalizeSabarimalaRoute('')).toBeNull();
      expect(normalizeSabarimalaRoute(null)).toBeNull();
      expect(normalizeSabarimalaRoute(undefined)).toBeNull();
    });
  });

  describe('2. normalizeDemandKey consistency', () => {
    it('produces the exact same demand key for equivalent Erumeli / Erumely labels', () => {
      const key1 = normalizeDemandKey('2027-01-02', 'Erumeli Traditional');
      const key2 = normalizeDemandKey('2027-01-02', 'Erumely - Kalaketti Traditional Path - 46 Kms');
      const key3 = normalizeDemandKey('2027-01-02', 'Erumeli (Perur Thodu - Kalaketty Traditional)');

      expect(key1).toBe('2027-01-02:ERUMELY');
      expect(key2).toBe('2027-01-02:ERUMELY');
      expect(key3).toBe('2027-01-02:ERUMELY');
      expect(key1).toBe(key2);
      expect(key2).toBe(key3);
    });

    it('produces the exact same demand key for equivalent Vandiperiyar / Pulmedu labels', () => {
      const key1 = normalizeDemandKey('2027-01-02', 'Vandiperiyar / Pulmedu');
      const key2 = normalizeDemandKey('2027-01-02', 'Vandiperiyar - Sathram - Pulmedu - 16 Kms');

      expect(key1).toBe('2027-01-02:VANDIPERIYAR');
      expect(key2).toBe('2027-01-02:VANDIPERIYAR');
      expect(key1).toBe(key2);
    });

    it('produces the exact same demand key for equivalent Pamba labels', () => {
      const key1 = normalizeDemandKey('2027-01-02', 'Pamba Base');
      const key2 = normalizeDemandKey('2027-01-02', 'Pamba - Marakkoottam - 4 Kms');
      const key3 = normalizeDemandKey('2027-01-02', 'Pamba (Regular Footpath Route)');

      expect(key1).toBe('2027-01-02:PAMBA');
      expect(key2).toBe('2027-01-02:PAMBA');
      expect(key3).toBe('2027-01-02:PAMBA');
      expect(key1).toBe(key2);
    });

    it('does not produce PAMBA for Nilakkal Shuttle or unknown routes', () => {
      const keyNilakkal = normalizeDemandKey('2027-01-02', 'Nilakkal - Pamba Shuttle Route');
      expect(keyNilakkal).not.toBe('2027-01-02:PAMBA');
      expect(keyNilakkal).toContain('NILAKKAL');
    });
  });

  describe('3. isRouteMatching and isSameSabarimalaRoute', () => {
    it('matches equivalent route pairs accurately', () => {
      expect(isRouteMatching('Erumeli Traditional', 'Erumely - Kalaketti Traditional Path - 46 Kms')).toBe(true);
      expect(isRouteMatching('Erumeli (Perur Thodu - Kalaketty Traditional)', 'ERUMELY')).toBe(true);
      expect(isRouteMatching('Vandiperiyar / Pulmedu', 'Vandiperiyar - Sathram - Pulmedu - 16 Kms')).toBe(true);
      expect(isRouteMatching('Pamba (Regular Footpath Route)', 'Pamba - Marakkoottam - 4 Kms')).toBe(true);
      expect(isSameSabarimalaRoute('Erumeli Traditional', 'Erumely - Kalaketti Traditional Path - 46 Kms')).toBe(true);
    });

    it('never matches unrelated routes', () => {
      expect(isRouteMatching('Erumeli Traditional', 'Pamba - Marakkoottam - 4 Kms')).toBe(false);
      expect(isRouteMatching('Vandiperiyar / Pulmedu', 'Erumely Traditional')).toBe(false);
      expect(isRouteMatching('Pamba Base', 'Vandiperiyar / Pulmedu')).toBe(false);
      expect(isSameSabarimalaRoute('ERUMELY', 'PAMBA')).toBe(false);
    });

    it('never matches Nilakkal Shuttle with PAMBA', () => {
      expect(isRouteMatching('Nilakkal - Pamba Shuttle Route', 'Pamba - Marakkoottam - 4 Kms')).toBe(false);
      expect(isRouteMatching('Pamba Base', 'Nilakkal - Pamba Shuttle Route')).toBe(false);
    });

    it('never matches unknown route with supported route', () => {
      expect(isRouteMatching('Kottaiyadi Traditional Trek', 'Pamba - Marakkoottam - 4 Kms')).toBe(false);
      expect(isRouteMatching('Random Route XYZ', 'ERUMELY')).toBe(false);
    });
  });

  describe('4. Official portal route metadata', () => {
    it('returns exact official dropdown values (1, 2, 3)', () => {
      expect(getOfficialSabarimalaRouteValue(SabarimalaRoute.PAMBA)).toBe('1');
      expect(getOfficialSabarimalaRouteValue('Pamba (Regular Footpath Route)')).toBe('1');
      expect(getOfficialSabarimalaRouteValue(SabarimalaRoute.ERUMELY)).toBe('2');
      expect(getOfficialSabarimalaRouteValue('Erumeli Traditional')).toBe('2');
      expect(getOfficialSabarimalaRouteValue(SabarimalaRoute.VANDIPERIYAR)).toBe('3');
      expect(getOfficialSabarimalaRouteValue('Vandiperiyar / Pulmedu')).toBe('3');
      expect(getOfficialSabarimalaRouteValue('Nilakkal Shuttle')).toBeNull();
    });

    it('returns exact official portal labels', () => {
      expect(getOfficialSabarimalaRouteLabel(SabarimalaRoute.PAMBA)).toBe('Pamba - Marakkoottam - 4 Kms');
      expect(getOfficialSabarimalaRouteLabel('Erumeli Traditional')).toBe('Erumely - Kalaketti Traditional Path - 46 Kms');
      expect(getOfficialSabarimalaRouteLabel('Vandiperiyar / Pulmedu')).toBe('Vandiperiyar - Sathram - Pulmedu - 16 Kms');
    });
  });
});
