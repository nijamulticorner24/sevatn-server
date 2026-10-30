export interface NomineeValidationResult {
  valid: boolean;
  errors: string[];
  resolvedNominee?: {
    nomineeName: string;
    nomineeAge: number;
    nomineeRelationship: string;
    nomineePhone?: string;
  };
}

/**
 * Validates mandatory nominee details for pilgrim insurance.
 * Enforces:
 * 1. Nominee full name (>= 2 characters, non-empty)
 * 2. Adult age (>= 18 years, <= 120 years)
 * 3. Legitimate relationship (>= 2 characters, e.g. Father, Mother, Spouse, Brother, etc.)
 * 4. Pilgrim-to-nominee association
 */
export function validateNominee(bookingOrDto: {
  nominee?: any;
  nominees?: any[];
  nomineeName?: string;
  nomineeAge?: number;
  nomineeRelationship?: string;
  nomineePhone?: string;
  pilgrims?: any[];
  preferences?: any;
}): NomineeValidationResult {
  const errors: string[] = [];

  // Extract resolved primary nominee
  const primaryNominee =
    bookingOrDto.nominee ||
    (Array.isArray(bookingOrDto.nominees) && bookingOrDto.nominees[0]) ||
    (Array.isArray(bookingOrDto.preferences?.nominees) && bookingOrDto.preferences.nominees[0]) ||
    (bookingOrDto.nomineeName
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
    errors.push('Mandatory nominee information is missing for this booking.');
    return { valid: false, errors };
  }

  const name = primaryNominee.nomineeName?.trim();
  if (!name || name.length < 2) {
    errors.push('Nominee name must be at least 2 characters long.');
  }

  const age = Number(primaryNominee.nomineeAge);
  if (!age || isNaN(age) || age < 18 || age > 120) {
    errors.push('Nominee must be an adult with a valid age between 18 and 120 years.');
  }

  const rel = primaryNominee.nomineeRelationship?.trim();
  if (!rel || rel.length < 2) {
    errors.push('Nominee relationship is required.');
  }

  // Check per-pilgrim nominee associations if explicit individual nominees are supplied
  if (Array.isArray(bookingOrDto.pilgrims) && bookingOrDto.pilgrims.length > 0) {
    for (let i = 0; i < bookingOrDto.pilgrims.length; i++) {
      const p = bookingOrDto.pilgrims[i];
      if (p.nominee || p.nomineeName) {
        const pNomineeName = (p.nominee?.nomineeName || p.nomineeName)?.trim();
        const pNomineeAge = Number(p.nominee?.nomineeAge || p.nomineeAge);
        const pNomineeRel = (p.nominee?.nomineeRelationship || p.nomineeRelationship)?.trim();

        if (!pNomineeName || pNomineeName.length < 2) {
          errors.push(`Pilgrim #${i + 1}: Associated nominee name is invalid.`);
        }
        if (!pNomineeAge || isNaN(pNomineeAge) || pNomineeAge < 18 || pNomineeAge > 120) {
          errors.push(`Pilgrim #${i + 1}: Associated nominee must be at least 18 years of age.`);
        }
        if (!pNomineeRel || pNomineeRel.length < 2) {
          errors.push(`Pilgrim #${i + 1}: Associated nominee relationship is required.`);
        }
      }
    }
  }

  const valid = errors.length === 0;

  return {
    valid,
    errors,
    resolvedNominee: valid
      ? {
          nomineeName: name,
          nomineeAge: age,
          nomineeRelationship: rel,
          nomineePhone: primaryNominee.nomineePhone?.trim(),
        }
      : undefined,
  };
}

