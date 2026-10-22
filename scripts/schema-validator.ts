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
  additiveOperations: string[];
  summary: {
    tablesCreated: string[];
    columnsAdded: string[];
    indexesCreated: string[];
    foreignKeysAdded: string[];
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
  { regex: /\bTRUNCATE\b/i, description: 'Truncate Table' },
  { regex: /\bALTER\s+COLUMN\s+[^;]+\s+TYPE\b/i, description: 'Alter Column Type' },
  { regex: /\bSET\s+NOT\s+NULL\b/i, description: 'Set NOT NULL constraint without default' },
];

/**
 * Classifies statements in an SQL migration diff into additive vs destructive.
 */
export function classifySqlDiff(sqlDiff: string): SqlClassificationResult {
  const cleanSql = sqlDiff.trim();
  if (!cleanSql) {
    return {
      isAdditiveOnly: true,
      destructiveOperations: [],
      additiveOperations: [],
      summary: {
        tablesCreated: [],
        columnsAdded: [],
        indexesCreated: [],
        foreignKeysAdded: [],
        otherOperations: [],
      },
    };
  }

  // Split into individual SQL statements
  // Filter out comments and empty statements
  const statements = cleanSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => {
      const stripped = s.replace(/^--.*$/gm, '').trim();
      return stripped.length > 0;
    });

  const destructiveOperations: string[] = [];
  const additiveOperations: string[] = [];

  const summary = {
    tablesCreated: [] as string[],
    columnsAdded: [] as string[],
    indexesCreated: [] as string[],
    foreignKeysAdded: [] as string[],
    otherOperations: [] as string[],
  };

  for (const statement of statements) {
    const normalized = statement.replace(/\s+/g, ' ');

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

    // Classify additive operation
    if (/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?/i.test(normalized)) {
      const match = normalized.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?/i);
      summary.tablesCreated.push(match ? match[1] : normalized);
      additiveOperations.push(normalized);
    } else if (/ALTER\s+TABLE\s+["']?([a-zA-Z0-9_]+)["']?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?/i.test(normalized)) {
      const match = normalized.match(/ALTER\s+TABLE\s+["']?([a-zA-Z0-9_]+)["']?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?\s+([^,;]+)/i);
      summary.columnsAdded.push(match ? `${match[1]}.${match[2]} (${match[3].trim()})` : normalized);
      additiveOperations.push(normalized);
    } else if (/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?/i.test(normalized)) {
      const match = normalized.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?\s+ON\s+["']?([a-zA-Z0-9_]+)["']?/i);
      summary.indexesCreated.push(match ? `${match[1]} on ${match[2]}` : normalized);
      additiveOperations.push(normalized);
    } else if (/ADD\s+CONSTRAINT\s+["']?([a-zA-Z0-9_]+)["']?\s+FOREIGN\s+KEY/i.test(normalized)) {
      const match = normalized.match(/ADD\s+CONSTRAINT\s+["']?([a-zA-Z0-9_]+)["']?\s+FOREIGN\s+KEY/i);
      summary.foreignKeysAdded.push(match ? match[1] : normalized);
      additiveOperations.push(normalized);
    } else {
      summary.otherOperations.push(normalized);
      additiveOperations.push(normalized);
    }
  }

  return {
    isAdditiveOnly: destructiveOperations.length === 0,
    destructiveOperations,
    additiveOperations,
    summary,
  };
}
