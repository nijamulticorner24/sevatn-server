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
      const calculatedScriptDir = path.posix.normalize(prodScriptDir);
      expect(calculatedScriptDir).toBe('/home/ubuntu/sevatn-server/scripts');
    });

    it('resolves API_DIR to the repository root via SCRIPT_DIR/..', () => {
      const calculatedApiDir = path.posix.normalize(path.posix.join(prodScriptDir, '..'));
      expect(calculatedApiDir).toBe('/home/ubuntu/sevatn-server');
    });

    it('sets REPO_ROOT equal to API_DIR, NOT parent dirname', () => {
      const calculatedApiDir = path.posix.normalize(path.posix.join(prodScriptDir, '..'));
      const calculatedRepoRoot = calculatedApiDir;
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

  describe('Static Analysis of deploy-production.sh (Git Safety & Deployment Order)', () => {
    let scriptContent: string;

    beforeAll(() => {
      scriptContent = fs.readFileSync(deployScriptPath, 'utf8');
    });

    it('sets SCRIPT_DIR to script directory and REPO_ROOT to API_DIR directly', () => {
      expect(scriptContent).toMatch(/SCRIPT_DIR="?\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"?/);
      expect(scriptContent).toMatch(/API_DIR="?\$\(cd "\$\{SCRIPT_DIR\}\/\.\." && pwd\)"?/);
      expect(scriptContent).toMatch(/REPO_ROOT="?\$\{API_DIR\}"?/);
      expect(scriptContent).not.toMatch(/REPO_ROOT="?\$\(cd "\$\{API_DIR\}\/\.\." && pwd\)"?/);
    });

    it('validates package.json, package-lock.json, and prisma/schema.prisma in REPO_ROOT with fail-closed exits', () => {
      expect(scriptContent).toMatch(/if \[ ! -f "\$\{REPO_ROOT\}\/package\.json" \]; then[\s\S]*?exit 1/);
      expect(scriptContent).toMatch(/if \[ ! -f "\$\{REPO_ROOT\}\/package-lock\.json" \]; then[\s\S]*?exit 1/);
      expect(scriptContent).toMatch(/if \[ ! -f "\$\{REPO_ROOT\}\/prisma\/schema\.prisma" \]; then[\s\S]*?exit 1/);
    });

    it('enforces fatal fetch and fatal pull --ff-only on Git synchronization', () => {
      // Must not continue on failure
      expect(scriptContent).toMatch(/git fetch origin "\$\{EXPECTED_BRANCH\}"/);
      expect(scriptContent).toMatch(/git pull --ff-only origin "\$\{EXPECTED_BRANCH\}"/);
      expect(scriptContent).not.toMatch(/git pull --ff-only[\s\S]*?Proceeding with current checkout/);
    });

    it('aborts on unexpected tracked modifications and preserves working files', () => {
      expect(scriptContent).toContain('TRACKED_DIFF=$(git diff --name-only)');
      expect(scriptContent).toMatch(/if \[ -n "\$\{TRACKED_DIFF\}" \][\s\S]*?exit 1/);
      expect(scriptContent).toContain('Preserving .env, dist/, node_modules/, and existing stash');
      expect(scriptContent).not.toContain('git reset --hard');
      expect(scriptContent).not.toContain('git clean -fd');
      expect(scriptContent).not.toContain('git checkout -- .');
    });

    it('verifies checked-out commit matches intended release when EXPECTED_COMMIT is provided', () => {
      expect(scriptContent).toContain('EXPECTED_COMMIT');
      expect(scriptContent).toMatch(/does not match intended release commit/);
    });

    it('enforces the exact deployment order: install -> validate -> generate -> build -> dry-run -> approval -> live sync -> pm2', () => {
      const npmCiIdx = scriptContent.indexOf('npm ci');
      const validateIdx = scriptContent.indexOf('npx prisma validate');
      const generateIdx = scriptContent.indexOf('npx prisma generate');
      const buildIdx = scriptContent.indexOf('npm run build');
      const dryRunIdx = scriptContent.indexOf('npm run schema:dry-run');
      const approvalGateIdx = scriptContent.indexOf('CONFIRM_PRODUCTION_SCHEMA_SYNC');
      const liveSyncIdx = scriptContent.indexOf('npm run schema:sync');
      const pm2RestartIdx = scriptContent.indexOf('pm2 restart');
      const healthCheckIdx = scriptContent.indexOf('HEALTH_URL');

      expect(npmCiIdx).toBeGreaterThan(0);
      expect(validateIdx).toBeGreaterThan(npmCiIdx);
      expect(generateIdx).toBeGreaterThan(validateIdx);
      expect(buildIdx).toBeGreaterThan(generateIdx);
      expect(dryRunIdx).toBeGreaterThan(buildIdx);
      expect(approvalGateIdx).toBeGreaterThan(dryRunIdx);
      expect(liveSyncIdx).toBeGreaterThan(approvalGateIdx);
      expect(pm2RestartIdx).toBeGreaterThan(liveSyncIdx);
      expect(healthCheckIdx).toBeGreaterThan(pm2RestartIdx);
    });

    it('fails closed when health check returns non-200 HTTP code', () => {
      expect(scriptContent).toMatch(/if \[ "\$\{HTTP_CODE\}" != "200" \]; then[\s\S]*?exit 1/);
    });
  });

  describe('Bash Syntax Verification', () => {
    it('passes bash syntax check (bash -n)', () => {
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
        if (err.message && err.message.includes('not found')) {
          console.warn('Bash not found, skipping syntax check');
        } else {
          throw err;
        }
      }
    });
  });
});
