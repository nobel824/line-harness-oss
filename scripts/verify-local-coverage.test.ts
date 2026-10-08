import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const verifyLocal = readFileSync(join(root, 'scripts/verify-local.mjs'), 'utf8');
const expectedBuildOnly = ['create-line-harness', 'liff', 'web'];

function packagesWithoutTypecheck(): string[] {
  const names: string[] = [];
  for (const workspaceRoot of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, workspaceRoot), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJsonPath = join(root, workspaceRoot, entry.name, 'package.json');
      let pkg: { name?: string; scripts?: Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!pkg.scripts?.typecheck) names.push(pkg.name ?? packageJsonPath);
    }
  }
  return names.sort();
}

describe('verify:local compile coverage', () => {
  test('every workspace without typecheck is explicitly compiled with build', () => {
    expect(packagesWithoutTypecheck()).toEqual(expectedBuildOnly);
    for (const packageName of expectedBuildOnly) {
      expect(verifyLocal).toContain(`'${packageName}'`);
    }
    expect(verifyLocal).toContain('assertCompileCoverage();');
  });
});
