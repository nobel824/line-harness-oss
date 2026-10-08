import { spawnSync } from 'node:child_process';
import publicAdminKeyGuard from './public-admin-key-guard.cjs';

const { assertNoPublicAdminKey } = publicAdminKeyGuard;

// Fail before any build/test subprocess and never echo the configured value.
assertNoPublicAdminKey();

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const steps = [
  {
    name: 'Web依存のbuild',
    args: [
      '--filter',
      '@line-crm/shared',
      '--filter',
      '@line-harness/update-engine',
      'build',
    ],
  },
  { name: 'Web compile build', args: ['--filter', 'web', 'build'] },
  { name: 'Web unit test', args: ['--filter', 'web', 'test'] },
  {
    name: 'Codex readiness test',
    args: [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.config.ts',
      'scripts/update-banner-toggle.test.ts',
      'scripts/public-admin-key-guard.test.ts',
      'scripts/verify-local-coverage.test.ts',
    ],
  },
];

for (const step of steps) {
  console.log(`\n[verify:readiness] ${step.name}`);
  const result = spawnSync(pnpm, step.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[verify:readiness] ${step.name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('\n[verify:readiness] all checks passed');
