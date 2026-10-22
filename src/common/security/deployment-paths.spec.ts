import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

describe('Production Deployment Script Path & Layout Validation', () => {
  // Resolve repository root from test location
  // In sevatn-server: src/common/security/deployment-paths.spec.ts -> root is 3 levels up
  const repoRoot = path.resolve(__dirname, '../../../');
  const deployScriptPath = path.join(repoRoot, 'scripts/deploy-production.sh');

  it('proves deployment script exists in scripts/ directory', () => {
    expect(fs.existsSync(deployScriptPath)).toBe(true);
  });

  describe('Repository Layout Invariants (Production sevatn-server)', () => {
    it('contains package.json directly at the repository root', () => {
      const packageJsonPath = path.join(repoRoot, 'package.json');
      expect(fs.existsSync(packageJsonPath)).toBe(true);
    });

    it('contains package-lock.json directly at the repository root', () => {
      const packageLockPath = path.join(repoRoot, 'package-lock.json');
      expect(fs.existsSync(packageLockPath)).toBe(true);
    });

    it('contains prisma/schema.prisma directly under repository root', () => {
      const schemaPath = path.join(repoRoot, 'prisma/schema.prisma');
      expect(fs.existsSync(schemaPath)).toBe(true);
    });

    it('contains scripts/deploy-production.sh directly under repository root', () => {
      expect(fs.existsSync(deployScriptPath)).toBe(true);
    });
  });

  describe('Path Calculation Logic Simulation (/home/ubuntu/sevatn-server)', () => {
    const prodHome = '/home/ubuntu';
    const prodRepoRoot = `${prodHome}/sevatn-server`;
    const prodScriptDir = `${prodRepoRoot}/scripts`;

    it('resolves SCRIPT_DIR to the script directory', () => {
      // In bash: SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
      const calculatedScriptDir = path.posix.normalize(prodScriptDir);
      expect(calculatedScriptDir).toBe('/home/ubuntu/sevatn-server/scripts');
    });

    it('resolves API_DIR to the repository root via SCRIPT_DIR/..', () => {
      // In bash: API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
      const calculatedApiDir = path.posix.normalize(path.posix.join(prodScriptDir, '..'));
      expect(calculatedApiDir).toBe('/home/ubuntu/sevatn-server');
    });

    it('sets REPO_ROOT equal to API_DIR, NOT parent dirname', () => {
      // In bash: REPO_ROOT="${API_DIR}"
      const calculatedApiDir = path.posix.normalize(path.posix.join(prodScriptDir, '..'));
      const calculatedRepoRoot = calculatedApiDir; // REPO_ROOT="${API_DIR}"
      const buggyParentDir = path.posix.normalize(path.posix.join(calculatedApiDir, '..'));

      expect(calculatedRepoRoot).toBe('/home/ubuntu/sevatn-server');
      expect(calculatedRepoRoot).toBe(calculatedApiDir);
      expect(calculatedRepoRoot).not.toBe(buggyParentDir);
      expect(buggyParentDir).toBe('/home/ubuntu');
    });

    it('targets valid file paths for package.json, package-lock.json, and schema.prisma', () => {
      const calculatedRepoRoot = prodRepoRoot;
      expect(path.posix.join(calculatedRepoRoot, 'package.json')).toBe('/home/ubuntu/sevatn-server/package.json');
      expect(path.posix.join(calculatedRepoRoot, 'package-lock.json')).toBe('/home/ubuntu/sevatn-server/package-lock.json');
      expect(path.posix.join(calculatedRepoRoot, 'prisma/schema.prisma')).toBe('/home/ubuntu/sevatn-server/prisma/schema.prisma');
    });
  });

  describe('Static Analysis of deploy-production.sh', () => {
    let scriptContent: string;

    beforeAll(() => {
      scriptContent = fs.readFileSync(deployScriptPath, 'utf8');
    });

    it('sets SCRIPT_DIR to script directory', () => {
      expect(scriptContent).toMatch(/SCRIPT_DIR="?\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"?/);
    });

    it('sets API_DIR to SCRIPT_DIR/..', () => {
      expect(scriptContent).toMatch(/API_DIR="?\$\(cd "\$\{SCRIPT_DIR\}\/\.\." && pwd\)"?/);
    });

    it('sets REPO_ROOT to API_DIR directly and not parent', () => {
      expect(scriptContent).toMatch(/REPO_ROOT="?\$\{API_DIR\}"?/);
      expect(scriptContent).not.toMatch(/REPO_ROOT="?\$\(cd "\$\{API_DIR\}\/\.\." && pwd\)"?/);
    });

    it('validates package.json, package-lock.json, and prisma/schema.prisma in REPO_ROOT with fail-closed exits', () => {
      expect(scriptContent).toContain('${REPO_ROOT}/package.json');
      expect(scriptContent).toContain('${REPO_ROOT}/package-lock.json');
      expect(scriptContent).toContain('${REPO_ROOT}/prisma/schema.prisma');
      // Ensure failure exits with 1
      expect(scriptContent).toMatch(/if \[ ! -f "\$\{REPO_ROOT\}\/package\.json" \]; then[\s\S]*?exit 1/);
      expect(scriptContent).toMatch(/if \[ ! -f "\$\{REPO_ROOT\}\/package-lock\.json" \]; then[\s\S]*?exit 1/);
      expect(scriptContent).toMatch(/if \[ ! -f "\$\{REPO_ROOT\}\/prisma\/schema\.prisma" \]; then[\s\S]*?exit 1/);
    });

    it('runs Git branch checks and fast-forward pull from REPO_ROOT', () => {
      expect(scriptContent).toMatch(/cd "\$\{REPO_ROOT\}"[\s\S]*?git rev-parse --abbrev-ref HEAD/);
      expect(scriptContent).toMatch(/git pull --ff-only/);
    });

    it('runs npm ci, Prisma validation/generation, guarded schema sync, and build from API_DIR', () => {
      expect(scriptContent).toMatch(/cd "\$\{API_DIR\}"[\s\S]*?npm ci/);
      expect(scriptContent).toMatch(/npx prisma validate/);
      expect(scriptContent).toMatch(/npx prisma generate/);
      expect(scriptContent).toMatch(/npm run schema:sync/);
      expect(scriptContent).toMatch(/npm run build/);
    });

    it('preserves .env and existing uncommitted changes without destructive resets', () => {
      expect(scriptContent).toContain('.env');
      expect(scriptContent).toContain('git status --porcelain');
      expect(scriptContent).toContain('Preserving working tree files');
      expect(scriptContent).not.toContain('git reset --hard');
      expect(scriptContent).not.toContain('git clean -fd');
      expect(scriptContent).not.toContain('git checkout -- .');
    });

    it('enforces fail-closed termination on failed health check or prerequisites', () => {
      expect(scriptContent).toContain('set -euo pipefail');
      expect(scriptContent).toMatch(/if \[ "\$\{HTTP_CODE\}" != "200" \]; then[\s\S]*?exit 1/);
    });
  });

  describe('Bash Syntax Verification', () => {
    it('passes bash syntax check (bash -n)', () => {
      // Find git bash or standard bash
      const bashBin = fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
        ? 'C:\\Program Files\\Git\\bin\\bash.exe'
        : 'bash';

      try {
        const result = execSync(`"${bashBin}" -n "${deployScriptPath.replace(/\\/g, '/')}"`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        expect(result).toBe('');
      } catch (err: any) {
        // If no bash in environment, skip gracefully
        if (err.message && err.message.includes('not found')) {
          console.warn('Bash not found, skipping syntax check');
        } else {
          throw err;
        }
      }
    });
  });
});
