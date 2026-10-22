import { URL } from 'url';

export interface DatabaseValidationResult {
  isValid: boolean;
  error?: string;
  dbName: string;
  dbHost: string;
  dbPort: string;
  maskedUrl: string;
}

export interface SqlClassificationResult {
  isAdditiveOnly: boolean;
  destructiveOperations: string[];
  unapprovedOperations: string[];
  additiveOperations: string[];
  totalStatements: number;
  summary: {
    tablesCreated: string[];
    columnsAdded: string[];
    indexesCreated: string[];
    foreignKeysAdded: string[];
    primaryKeysAdded: string[];
    enumsCreated: string[];
    enumValuesAdded: string[];
    sequencesCreated: string[];
    otherOperations: string[];
  };
}

/**
 * Mask credentials in a PostgreSQL connection URL.
 * Never prints password, username, or authentication tokens.
 */
export function maskDatabaseUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return 'postgresql://***:***@***/***';
  }
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname || '***';
    const port = parsed.port ? `:${parsed.port}` : '';
    const db = parsed.pathname || '/***';
    return `postgresql://***:***@${host}${port}${db}`;
  } catch {
    return 'postgresql://***:***@***/***';
  }
}

/**
 * Validates the database URL against strict production rules.
 * Fails closed on any mismatch in database name or unapproved hostname.
 */
export function validateDatabaseUrl(
  rawUrl: string | undefined,
  options: {
    nodeEnv?: string;
    expectedDbName?: string;
    expectedDbHost?: string;
    allowCustomDbHost?: boolean;
  } = {},
): DatabaseValidationResult {
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV || 'development';
  const expectedDbName = options.expectedDbName || 'servicetn_db';
  const expectedDbHost = options.expectedDbHost || process.env.EXPECTED_DB_HOST;
  const allowCustomDbHost = options.allowCustomDbHost ?? (process.env.ALLOW_CUSTOM_DB_HOST === 'true');

  if (!rawUrl || rawUrl.trim().length === 0) {
    return {
      isValid: false,
      error: 'DATABASE_URL environment variable is missing or empty.',
      dbName: '',
      dbHost: '',
      dbPort: '',
      maskedUrl: 'postgresql://***:***@***/***',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (err: any) {
    return {
      isValid: false,
      error: `Malformed DATABASE_URL: ${err.message}`,
      dbName: '',
      dbHost: '',
      dbPort: '',
      maskedUrl: 'postgresql://***:***@***/***',
    };
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return {
      isValid: false,
      error: `Invalid protocol '${parsed.protocol}'. Expected 'postgresql:' or 'postgres:'.`,
      dbName: '',
      dbHost: '',
      dbPort: '',
      maskedUrl: maskDatabaseUrl(rawUrl),
    };
  }

  const dbHost = parsed.hostname;
  const dbPort = parsed.port || '5432';
  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  const maskedUrl = maskDatabaseUrl(rawUrl);

  if (!dbName) {
    return {
      isValid: false,
      error: 'DATABASE_URL does not specify a database name.',
      dbName: '',
      dbHost,
      dbPort,
      maskedUrl,
    };
  }

  // Production Enforcements (Strict Fail-Closed)
  if (nodeEnv === 'production') {
    // 1. Database name check
    if (dbName !== expectedDbName) {
      return {
        isValid: false,
        error: `Production database name mismatch. Expected '${expectedDbName}', but received '${dbName}'.`,
        dbName,
        dbHost,
        dbPort,
        maskedUrl,
      };
    }

    // 2. Hostname validation
    if (expectedDbHost) {
      if (dbHost.toLowerCase() !== expectedDbHost.toLowerCase()) {
        return {
          isValid: false,
          error: `Production database host mismatch. Expected '${expectedDbHost}', but received '${dbHost}'.`,
          dbName,
          dbHost,
          dbPort,
          maskedUrl,
        };
      }
    } else if (!allowCustomDbHost) {
      // Must be an AWS RDS endpoint or valid cloud database
      const isAwsRds = /\.rds\.amazonaws\.com$/i.test(dbHost) || /\.rds\.[a-z0-9-]+\.amazonaws\.com$/i.test(dbHost);
      const isLocalhost = dbHost === 'localhost' || dbHost === '127.0.0.1' || dbHost === '::1';

      if (isLocalhost) {
        return {
          isValid: false,
          error: `Production DATABASE_URL cannot target localhost ('${dbHost}'). Expected AWS RDS production instance.`,
          dbName,
          dbHost,
          dbPort,
          maskedUrl,
        };
      }

      if (!isAwsRds) {
        return {
          isValid: false,
          error: `Production database host '${dbHost}' is not a recognized AWS RDS endpoint (*.rds.amazonaws.com). Set EXPECTED_DB_HOST or ALLOW_CUSTOM_DB_HOST=true if this is intentional.`,
          dbName,
          dbHost,
          dbPort,
          maskedUrl,
        };
      }
    }
  }

  return {
    isValid: true,
    dbName,
    dbHost,
    dbPort,
    maskedUrl,
  };
}

/**
 * Patterns that indicate destructive database operations.
 */
const DESTRUCTIVE_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  { regex: /\bDROP\s+TABLE\b/i, description: 'Drop Table' },
  { regex: /\bDROP\s+COLUMN\b/i, description: 'Drop Column' },
  { regex: /\bALTER\s+TABLE\s+[^;]+\s+DROP\b/i, description: 'Table Alter Drop' },
  { regex: /\bDROP\s+VIEW\b/i, description: 'Drop View' },
  { regex: /\bDROP\s+INDEX\b/i, description: 'Drop Index' },
  { regex: /\bDROP\s+SEQUENCE\b/i, description: 'Drop Sequence' },
  { regex: /\bDROP\s+TYPE\b/i, description: 'Drop Enum / Custom Type' },
  { regex: /\bDROP\s+CONSTRAINT\b/i, description: 'Drop Constraint' },
  { regex: /\bDROP\s+SCHEMA\b/i, description: 'Drop Schema' },
  { regex: /\bDROP\s+DATABASE\b/i, description: 'Drop Database' },
  { regex: /\bTRUNCATE\b/i, description: 'Truncate Table' },
  { regex: /\bALTER\s+(?:TABLE\s+[^;]+\s+)?ALTER\s+COLUMN\s+[^;]+\s+TYPE\b/i, description: 'Alter Column Type' },
  { regex: /\bALTER\s+(?:TABLE\s+[^;]+\s+)?ALTER\s+COLUMN\s+[^;]+\s+DROP\s+DEFAULT\b/i, description: 'Drop Column Default' },
  { regex: /\bSET\s+NOT\s+NULL\b/i, description: 'Set NOT NULL constraint without default' },
  { regex: /\bRENAME\s+(?:TO|COLUMN)\b/i, description: 'Rename Table / Column' },
  { regex: /\bDELETE\s+FROM\b/i, description: 'Data Mutation (DELETE)' },
  { regex: /\bUPDATE\s+[^;]+\s+SET\b/i, description: 'Data Mutation (UPDATE)' },
  { regex: /\bINSERT\s+INTO\b/i, description: 'Data Mutation (INSERT)' },
  { regex: /\b(?:GRANT|REVOKE)\b/i, description: 'Permissions Change (GRANT/REVOKE)' },
];

/**
 * Robustly splits SQL text into individual statements, ignoring semicolons
 * inside single quotes ('...'), double quotes ("..."), and comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '-' && nextChar === '-') {
        inLineComment = true;
        i++;
        continue;
      }
      if (char === '/' && nextChar === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (char === "'" && !inDoubleQuote) {
      if (inSingleQuote && nextChar === "'") {
        current += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }

  return statements;
}

/**
 * Classifies statements in an SQL migration diff into additive vs destructive.
 * STRICT FAIL-CLOSED ENFORCEMENT:
 * 1. Only explicitly reviewed and approved additive statement types are permitted.
 * 2. Every unknown or unclassified statement is rejected.
 * 3. Any destructive statement, type narrowing, or unsafe constraint/default is rejected.
 * 4. Empty or unclassified diffs cannot be reported as safe.
 */
export function classifySqlDiff(sqlDiff: string): SqlClassificationResult {
  const statements = splitSqlStatements(sqlDiff);

  const destructiveOperations: string[] = [];
  const unapprovedOperations: string[] = [];
  const additiveOperations: string[] = [];

  const summary = {
    tablesCreated: [] as string[],
    columnsAdded: [] as string[],
    indexesCreated: [] as string[],
    foreignKeysAdded: [] as string[],
    primaryKeysAdded: [] as string[],
    enumsCreated: [] as string[],
    enumValuesAdded: [] as string[],
    sequencesCreated: [] as string[],
    otherOperations: [] as string[],
  };

  // Fail-closed rule 1: Empty or comment-only diff cannot be reported as safe
  if (statements.length === 0) {
    unapprovedOperations.push('SQL diff contains no actionable statements. Empty or unclassified diff cannot be reported as safe.');
    return {
      isAdditiveOnly: false,
      destructiveOperations,
      unapprovedOperations,
      additiveOperations,
      totalStatements: 0,
      summary,
    };
  }

  for (const statement of statements) {
    const normalized = statement.replace(/\s+/g, ' ').trim();

    // 1. Check known destructive patterns
    let isDestructive = false;
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.regex.test(normalized)) {
        destructiveOperations.push(`[${pattern.description}] ${normalized}`);
        isDestructive = true;
        break;
      }
    }

    if (isDestructive) {
      continue;
    }

    // 2. Check for unsafe constraints or unsafe defaults on ALTER TABLE ADD COLUMN
    // If a column is added as NOT NULL on an existing table without a DEFAULT value, PostgreSQL rejects it or locks table
    if (/^ALTER\s+TABLE\s+["']?([a-zA-Z0-9_]+)["']?\s+ADD\s+(?:COLUMN\s+)?(?!CONSTRAINT\b)["']?([a-zA-Z0-9_]+)["']?/i.test(normalized)) {
      const hasNotNull = /\bNOT\s+NULL\b/i.test(normalized);
      const hasDefault = /\bDEFAULT\b/i.test(normalized);
      if (hasNotNull && !hasDefault) {
        destructiveOperations.push(`[Unsafe Constraint / Default] Adding NOT NULL column without a DEFAULT value: ${normalized}`);
        continue;
      }
    }

    // 3. Match against explicitly approved additive statement types

    // Type 1: CREATE TABLE (quoted or unquoted identifier)
    const createTableMatch = normalized.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?\s*\(/i);
    if (createTableMatch) {
      summary.tablesCreated.push(createTableMatch[1]);
      additiveOperations.push(normalized);
      continue;
    }

    // Type 2: ALTER TABLE ADD CONSTRAINT ... FOREIGN KEY (must precede addColumnMatch)
    const addFkMatch = normalized.match(/^ALTER\s+TABLE\s+["']?([a-zA-Z0-9_]+)["']?\s+ADD\s+CONSTRAINT\s+["']?([a-zA-Z0-9_]+)["']?\s+FOREIGN\s+KEY/i);
    if (addFkMatch) {
      summary.foreignKeysAdded.push(`${addFkMatch[2]} on ${addFkMatch[1]}`);
      additiveOperations.push(normalized);
      continue;
    }

    // Type 3: ALTER TABLE ADD CONSTRAINT ... PRIMARY KEY
    const addPkMatch = normalized.match(/^ALTER\s+TABLE\s+["']?([a-zA-Z0-9_]+)["']?\s+ADD\s+CONSTRAINT\s+["']?([a-zA-Z0-9_]+)["']?\s+PRIMARY\s+KEY/i);
    if (addPkMatch) {
      summary.primaryKeysAdded.push(`${addPkMatch[2]} on ${addPkMatch[1]}`);
      additiveOperations.push(normalized);
      continue;
    }

    // Type 4: ALTER TABLE ADD COLUMN (explicitly negative lookahead on CONSTRAINT)
    const addColumnMatch = normalized.match(/^ALTER\s+TABLE\s+["']?([a-zA-Z0-9_]+)["']?\s+ADD\s+(?:COLUMN\s+)?(?!CONSTRAINT\b)["']?([a-zA-Z0-9_]+)["']?\s+(.+)$/i);
    if (addColumnMatch) {
      summary.columnsAdded.push(`${addColumnMatch[1]}.${addColumnMatch[2]} (${addColumnMatch[3].trim()})`);
      additiveOperations.push(normalized);
      continue;
    }

    // Type 5: CREATE [UNIQUE] INDEX
    const createIndexMatch = normalized.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?\s+ON\s+["']?([a-zA-Z0-9_]+)["']?/i);
    if (createIndexMatch) {
      summary.indexesCreated.push(`${createIndexMatch[1]} on ${createIndexMatch[2]}`);
      additiveOperations.push(normalized);
      continue;
    }

    // Type 6: CREATE TYPE ... AS ENUM
    const createEnumMatch = normalized.match(/^CREATE\s+TYPE\s+["']?([a-zA-Z0-9_]+)["']?\s+AS\s+ENUM\s*\(/i);
    if (createEnumMatch) {
      summary.enumsCreated.push(createEnumMatch[1]);
      additiveOperations.push(normalized);
      continue;
    }

    // Type 7: ALTER TYPE ... ADD VALUE
    const addEnumValueMatch = normalized.match(/^ALTER\s+TYPE\s+["']?([a-zA-Z0-9_]+)["']?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/i);
    if (addEnumValueMatch) {
      summary.enumValuesAdded.push(`${addEnumValueMatch[1]}: '${addEnumValueMatch[2]}'`);
      additiveOperations.push(normalized);
      continue;
    }

    // Type 8: CREATE SEQUENCE
    const createSeqMatch = normalized.match(/^CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?/i);
    if (createSeqMatch) {
      summary.sequencesCreated.push(createSeqMatch[1]);
      additiveOperations.push(normalized);
      continue;
    }

    // Fail-closed rule 2: Every statement not explicitly matching an approved pattern is REJECTED
    unapprovedOperations.push(`[Unapproved / Unknown Statement] ${normalized}`);
  }

  // Fail-closed rule 3: Safe ONLY if there are statements and ZERO destructive or unapproved operations
  const isAdditiveOnly =
    statements.length > 0 &&
    destructiveOperations.length === 0 &&
    unapprovedOperations.length === 0;

  return {
    isAdditiveOnly,
    destructiveOperations,
    unapprovedOperations,
    additiveOperations,
    totalStatements: statements.length,
    summary,
  };
}
