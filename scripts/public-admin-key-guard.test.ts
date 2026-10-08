import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const sentinel = 'must-never-appear-in-output';
const { assertNoPublicAdminKey, ERROR_MESSAGE } = require('./public-admin-key-guard.cjs') as {
  assertNoPublicAdminKey: (env?: NodeJS.ProcessEnv) => void;
  ERROR_MESSAGE: string;
};

describe('public admin key build guard', () => {
  test('allows an environment where the forbidden name is absent', () => {
    expect(() => assertNoPublicAdminKey({ SAFE_VALUE: 'ok' })).not.toThrow();
  });

  test.each(['', sentinel])('rejects a defined value without disclosing it', (value) => {
    expect(() => assertNoPublicAdminKey({ NEXT_PUBLIC_ADMIN_API_KEY: value })).toThrow(
      ERROR_MESSAGE,
    );
    try {
      assertNoPublicAdminKey({ NEXT_PUBLIC_ADMIN_API_KEY: value });
    } catch (error) {
      expect(String(error)).not.toContain(value || 'an-empty-value-cannot-appear');
    }
  });

  test('verify:readiness rejects inherited configuration before running build steps', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-readiness.mjs'], {
      cwd: root,
      env: { ...process.env, NEXT_PUBLIC_ADMIN_API_KEY: sentinel },
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(ERROR_MESSAGE);
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('[verify:readiness] Web依存のbuild');
  });

  test('Web build rejects even an empty legacy definition', () => {
    const result = spawnSync(pnpm, ['--filter', 'web', 'build'], {
      cwd: root,
      env: { ...process.env, NEXT_PUBLIC_ADMIN_API_KEY: '' },
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(ERROR_MESSAGE);
  });
});
