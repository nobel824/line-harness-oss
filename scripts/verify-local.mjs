import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const buildOnlyCompilePackages = new Set(['web', 'liff', 'create-line-harness']);

function assertCompileCoverage() {
  const uncovered = [];

  for (const workspaceRoot of ['apps', 'packages']) {
    for (const entry of readdirSync(join(process.cwd(), workspaceRoot), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJsonPath = join(process.cwd(), workspaceRoot, entry.name, 'package.json');
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }

      const hasTypecheck = typeof pkg.scripts?.typecheck === 'string';
      const coveredByBuild = buildOnlyCompilePackages.has(pkg.name);
      if (!hasTypecheck && !coveredByBuild) uncovered.push(pkg.name ?? packageJsonPath);
      if (coveredByBuild && typeof pkg.scripts?.build !== 'string') {
        uncovered.push(`${pkg.name} (build script missing)`);
      }
    }
  }

  if (uncovered.length > 0) {
    throw new Error(`compile check coverage missing: ${uncovered.join(', ')}`);
  }
}

assertCompileCoverage();

const steps = [
  {
    name: 'workspace依存のbuild',
    args: [
      '--filter',
      '@line-crm/shared',
      '--filter',
      '@line-crm/line-sdk',
      '--filter',
      '@line-harness/sdk',
      '--filter',
      '@line-harness/update-engine',
      'build',
    ],
  },
  {
    name: 'typecheck scriptを持たないworkspaceのcompile build',
    args: [
      '--filter',
      'web',
      '--filter',
      'liff',
      '--filter',
      'create-line-harness',
      'build',
    ],
  },
  {
    name: '全workspaceのtypecheck',
    args: ['-r', '--no-bail', '--if-present', 'typecheck'],
  },
  {
    name: '全workspaceのtest',
    args: ['-r', '--no-bail', '--if-present', 'test'],
  },
  {
    name: 'root scriptsとMCP serverのtest',
    args: ['test:scripts'],
  },
];

const failures = [];

for (const step of steps) {
  console.log(`\n[verify:local] ${step.name}`);
  const result = spawnSync(pnpm, step.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[verify:local] ${step.name}: ${result.error.message}`);
    failures.push(step.name);
    continue;
  }

  if (result.status !== 0) failures.push(step.name);
}

if (failures.length > 0) {
  console.error(`\n[verify:local] failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\n[verify:local] all checks passed');
}
