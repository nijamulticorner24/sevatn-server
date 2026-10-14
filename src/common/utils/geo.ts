/**
 * Geographic calculation and validation utilities for SevaTN 5 KM Access Control.
 */

const EARTH_RADIUS_KM = 6371.0;

export interface GeoCoordinate {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/**
 * Calculates great-circle distance between two points on the Earth's surface using Haversine formula.
 * @returns distance in kilometers (KM)
 */
export function calculateHaversineDistanceKm(
  coord1: { latitude: number; longitude: number },
  coord2: { latitude: number; longitude: number },
): number {
  const lat1Rad = toRadians(coord1.latitude);
  const lat2Rad = toRadians(coord2.latitude);
  const deltaLatRad = toRadians(coord2.latitude - coord1.latitude);
  const deltaLonRad = toRadians(coord2.longitude - coord1.longitude);

  const a =
    Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(deltaLonRad / 2) *
      Math.sin(deltaLonRad / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Number((EARTH_RADIUS_KM * c).toFixed(3));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180.0;
}

/**
 * Validates coordinate sanity and accuracy boundaries
 */
export function isValidCoordinate(coord: GeoCoordinate): { valid: boolean; reason?: string } {
  if (coord.latitude === undefined || coord.latitude === null || isNaN(coord.latitude)) {
    return { valid: false, reason: 'Latitude is missing or invalid' };
  }
  if (coord.longitude === undefined || coord.longitude === null || isNaN(coord.longitude)) {
    return { valid: false, reason: 'Longitude is missing or invalid' };
  }
  if (coord.latitude < -90 || coord.latitude > 90) {
    return { valid: false, reason: 'Latitude out of range [-90, +90]' };
  }
  if (coord.longitude < -180 || coord.longitude > 180) {
    return { valid: false, reason: 'Longitude out of range [-180, +180]' };
  }
  // Sanity check for precision / coordinate manipulation
  if (coord.latitude === 0 && coord.longitude === 0) {
    return { valid: false, reason: 'Coordinates at Null Island (0,0) are disallowed' };
  }
  if (coord.accuracy !== undefined && coord.accuracy > 2500) {
    return { valid: false, reason: `Location accuracy too low (${coord.accuracy}m). Must be under 2500m.` };
  }
  return { valid: true };
}
