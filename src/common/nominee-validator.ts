export interface ResolvedNomineeEntry {
  nomineeName: string;
  nomineeAge: number;
  nomineeRelationship: string;
  nomineePhone?: string;
}

export interface NomineeValidationResult {
  valid: boolean;
  errors: string[];
  resolvedNominee?: ResolvedNomineeEntry;
  resolvedNominees?: ResolvedNomineeEntry[];
}

/**
 * Official Sabarimala Portal Relationship Options (<select> values: 1..6, 11).
 */
export const OFFICIAL_SABARIMALA_RELATIONSHIPS = [
  'Father',
  'Mother',
  'Son',
  'Daughter',
  'Brother',
  'Sister',
  'Spouse',
] as const;

export type OfficialSabarimalaRelationship = (typeof OFFICIAL_SABARIMALA_RELATIONSHIPS)[number];

/**
 * Normalizes a relationship string to one of the 7 official Sabarimala portal options.
 * Maps Wife / Husband -> Spouse.
 * If allowLegacyFallback is true (for historical records), returns null only when empty.
 */
export function normalizeNomineeRelationship(
  rawRelationship: string | null | undefined,
  allowLegacyFallback = false,
): string | null {
  if (!rawRelationship) return null;
  const clean = rawRelationship.trim().toLowerCase();
  if (!clean) return null;

  const map: Record<string, OfficialSabarimalaRelationship> = {
    father: 'Father',
    '1': 'Father',
    mother: 'Mother',
    '2': 'Mother',
    son: 'Son',
    '3': 'Son',
    daughter: 'Daughter',
    '4': 'Daughter',
    brother: 'Brother',
    '5': 'Brother',
    sister: 'Sister',
    '6': 'Sister',
    spouse: 'Spouse',
    wife: 'Spouse',
    husband: 'Spouse',
    '11': 'Spouse',
  };

  if (map[clean]) {
    return map[clean];
  }

  if (allowLegacyFallback && clean.length >= 2) {
    return rawRelationship.trim();
  }

  return null;
}

/**
 * Validates mandatory nominee details for pilgrim insurance.
 * Enforces:
 * 1. Nominee full name (>= 2 characters, non-empty)
 * 2. Adult age (>= 18 years, <= 120 years)
 * 3. Legitimate official Sabarimala relationship (Father, Mother, Son, Daughter, Brother, Sister, Spouse)
 * 4. Optional strictRelationship check (enabled on new bookings)
 */
export function validateNominee(
  bookingOrDto: {
    nominee?: any;
    nominees?: any[];
    nomineeName?: string | null;
    nomineeAge?: number | null;
    nomineeRelationship?: string | null;
    nomineePhone?: string | null;
    pilgrims?: any[];
    preferences?: any;
  },
  options: { allowOptional?: boolean; strictOfficialRelationship?: boolean } = {
    allowOptional: true,
    strictOfficialRelationship: false,
  },
): NomineeValidationResult {
  const errors: string[] = [];

  // Extract resolved primary nominee
  const primaryNominee =
    bookingOrDto.nominee ||
    (Array.isArray(bookingOrDto.nominees) && bookingOrDto.nominees[0]) ||
    (Array.isArray(bookingOrDto.preferences?.nominees) && bookingOrDto.preferences.nominees[0]) ||
    (bookingOrDto.nomineeName !== undefined && bookingOrDto.nomineeName !== null
      ? {
          nomineeName: bookingOrDto.nomineeName,
          nomineeAge: bookingOrDto.nomineeAge,
          nomineeRelationship: bookingOrDto.nomineeRelationship,
          nomineePhone: bookingOrDto.nomineePhone,
        }
      : null) ||
    (Array.isArray(bookingOrDto.pilgrims) && bookingOrDto.pilgrims[0]?.nominee) ||
    (Array.isArray(bookingOrDto.pilgrims) && bookingOrDto.pilgrims[0]?.nomineeName
      ? {
          nomineeName: bookingOrDto.pilgrims[0].nomineeName,
          nomineeAge: bookingOrDto.pilgrims[0].nomineeAge,
          nomineeRelationship: bookingOrDto.pilgrims[0].nomineeRelationship,
          nomineePhone: bookingOrDto.pilgrims[0].nomineePhone,
        }
      : null);

  if (!primaryNominee) {
    if (options.allowOptional) {
      return { valid: true, errors: [], resolvedNominee: undefined };
    }
    errors.push('Mandatory nominee information is missing for this booking.');
    return { valid: false, errors };
  }

  const name = (primaryNominee.nomineeName || primaryNominee.fullName)?.trim();
  if (!name && !primaryNominee.nomineeAge && !primaryNominee.nomineeRelationship && options.allowOptional) {
    return { valid: true, errors: [], resolvedNominee: undefined };
  }

  if (!name || name.length < 2) {
    errors.push('Nominee name must be at least 2 characters long.');
  }

  const age = Number(primaryNominee.nomineeAge ?? primaryNominee.age);
  if (!age || isNaN(age) || age < 18 || age > 120) {
    errors.push('Nominee must be an adult with a valid age between 18 and 120 years.');
  }

  const rawRel = (primaryNominee.nomineeRelationship ?? primaryNominee.relationship)?.trim();
  const normalizedRel = normalizeNomineeRelationship(
    rawRel,
    !options.strictOfficialRelationship,
  );

  if (!rawRel || rawRel.length < 2) {
    errors.push('Nominee relationship is required.');
  } else if (!normalizedRel) {
    errors.push(
      `Nominee relationship "${rawRel}" is not supported by the Sabarimala portal. Allowed options: ${OFFICIAL_SABARIMALA_RELATIONSHIPS.join(', ')}.`,
    );
  }

  // Validate any explicit nominees array entries if provided (1 to 5 pilgrims)
  const resolvedNominees: ResolvedNomineeEntry[] = [];
  const rawNomineesList = Array.isArray(bookingOrDto.nominees) && bookingOrDto.nominees.length > 0
    ? bookingOrDto.nominees
    : Array.isArray(bookingOrDto.preferences?.nominees) && bookingOrDto.preferences.nominees.length > 0
      ? bookingOrDto.preferences.nominees
      : [];

  rawNomineesList.forEach((n, idx) => {
    if (!n) {
      errors.push(`Pilgrim #${idx + 1} nominee details are missing.`);
      return;
    }
    const nName = (n.nomineeName || n.fullName)?.trim();
    const nAge = Number(n.nomineeAge ?? n.age);
    const nRelRaw = (n.nomineeRelationship ?? n.relationship)?.trim();
    const nRelNorm = normalizeNomineeRelationship(nRelRaw, !options.strictOfficialRelationship);

    if (!nName || nName.length < 2) {
      errors.push(`Pilgrim #${idx + 1} nominee name must be at least 2 characters long.`);
    }
    if (!nAge || isNaN(nAge) || nAge < 18 || nAge > 120) {
      errors.push(`Pilgrim #${idx + 1} nominee must be an adult with a valid age between 18 and 120 years.`);
    }
    if (!nRelRaw || nRelRaw.length < 2) {
      errors.push(`Pilgrim #${idx + 1} nominee relationship is required.`);
    } else if (!nRelNorm) {
      errors.push(
        `Pilgrim #${idx + 1} nominee relationship "${nRelRaw}" is not supported by the Sabarimala portal. Allowed options: ${OFFICIAL_SABARIMALA_RELATIONSHIPS.join(', ')}.`,
      );
    }

    if (nName && nName.length >= 2 && nAge >= 18 && nAge <= 120 && (nRelNorm || (!options.strictOfficialRelationship && nRelRaw))) {
      resolvedNominees.push({
        nomineeName: nName,
        nomineeAge: nAge,
        nomineeRelationship: (nRelNorm || nRelRaw)!,
        nomineePhone: (n.nomineePhone ?? n.phone)?.trim(),
      });
    }
  });

  // Also validate any explicit per-pilgrim nominee objects if provided
  if (Array.isArray(bookingOrDto.pilgrims)) {
    bookingOrDto.pilgrims.forEach((p, idx) => {
      const pNom = p?.nominee;
      if (pNom) {
        const pName = (pNom.nomineeName || pNom.fullName)?.trim();
        const pAge = Number(pNom.nomineeAge ?? pNom.age);
        const pRel = (pNom.nomineeRelationship ?? pNom.relationship)?.trim();
        const pRelNorm = normalizeNomineeRelationship(pRel, !options.strictOfficialRelationship);
        if (!pName || pName.length < 2) {
          errors.push(`Pilgrim #${idx + 1} nominee name must be at least 2 characters long.`);
        }
        if (!pAge || isNaN(pAge) || pAge < 18 || pAge > 120) {
          errors.push(`Pilgrim #${idx + 1} nominee must be an adult with a valid age between 18 and 120 years.`);
        }
        if (!pRel || pRel.length < 2) {
          errors.push(`Pilgrim #${idx + 1} nominee relationship is required.`);
        } else if (!pRelNorm) {
          errors.push(
            `Pilgrim #${idx + 1} nominee relationship "${pRel}" is not supported by the Sabarimala portal. Allowed options: ${OFFICIAL_SABARIMALA_RELATIONSHIPS.join(', ')}.`,
          );
        }
      }
    });
  }

  const valid = errors.length === 0;
  const primaryResolved: ResolvedNomineeEntry | undefined = valid
    ? {
        nomineeName: name,
        nomineeAge: age,
        nomineeRelationship: normalizedRel || rawRel,
        nomineePhone: (primaryNominee.nomineePhone ?? primaryNominee.phone)?.trim(),
      }
    : undefined;

  return {
    valid,
    errors,
    resolvedNominee: primaryResolved,
    resolvedNominees: valid
      ? resolvedNominees.length > 0
        ? resolvedNominees
        : primaryResolved
          ? [primaryResolved]
          : undefined
      : undefined,
  };
}


