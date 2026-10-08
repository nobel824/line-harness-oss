import { describe, expect, test, vi } from 'vitest';
import {
  createStaffMember,
  getActiveStaffByEmail,
  normalizeStaffEmail,
  updateStaffMember,
} from '../src/staff.js';

const staff = {
  id: 'staff-1', name: 'Owner', email: 'owner@example.test', role: 'owner' as const,
  api_key: 'staff-key', is_active: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
};

function dbWithRows(rows: unknown[]): D1Database {
  const all = vi.fn(async () => ({ results: rows }));
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all })) }));
  return { prepare } as unknown as D1Database;
}

describe('staff email lookup for Access authentication', () => {
  test('uses a normalized email and resolves exactly one active staff member', async () => {
    const db = dbWithRows([staff]);
    await expect(getActiveStaffByEmail(db, ' OWNER@Example.Test ')).resolves.toEqual({
      kind: 'found', staff,
    });
    const statement = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(statement).toContain('is_active = 1');
    expect(statement).toContain('LOWER(TRIM(email)) = ?');
  });

  test('distinguishes unknown and duplicate active email matches', async () => {
    await expect(getActiveStaffByEmail(dbWithRows([]), 'unknown@example.test')).resolves.toEqual({
      kind: 'not_found',
    });
    await expect(getActiveStaffByEmail(dbWithRows([staff, { ...staff, id: 'staff-2' }]), 'owner@example.test'))
      .resolves.toEqual({ kind: 'duplicate' });
  });

  test('empty email is not a usable identity', () => {
    expect(normalizeStaffEmail('  ')).toBeNull();
  });

  test('normalizes email on create and update', async () => {
    const insertBind = vi.fn(() => ({ run: vi.fn() }));
    const updateBind = vi.fn(() => ({ run: vi.fn() }));
    const first = vi.fn(async () => staff);
    const prepare = vi.fn((sql: string) => {
      if (sql.startsWith('INSERT')) return { bind: insertBind };
      if (sql.startsWith('UPDATE')) return { bind: updateBind };
      return { bind: vi.fn(() => ({ first })) };
    });
    const db = { prepare } as unknown as D1Database;

    await createStaffMember(db, { name: 'Owner', email: ' OWNER@Example.Test ', role: 'owner' });
    expect(insertBind.mock.calls[0]?.[2]).toBe('owner@example.test');
    await updateStaffMember(db, staff.id, { email: ' UPDATED@Example.Test ' });
    expect(updateBind.mock.calls[0]).toContain('updated@example.test');
  });
});
