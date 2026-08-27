import { afterEach, describe, expect, test, vi } from 'vitest';
import { getStaffGoogleBusy } from './booking-calendar-sync.js';

type StubDb = D1Database & { calls: { sql: string; params: unknown[] }[] };

afterEach(() => {
  vi.restoreAllMocks();
});

function stubDb(busyCalendarIds: string | null | undefined) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            first: async () => ({
              id: 'connection-1',
              calendar_id: 'primary@example.com',
              auth_type: 'api_key',
              access_token: 'token',
              refresh_token: null,
              ...(busyCalendarIds === undefined ? {} : { busy_calendar_ids: busyCalendarIds }),
            }),
          };
        },
      };
    },
  } as unknown as StubDb;
}

describe('getStaffGoogleBusy', () => {
  test.each([
    ['壊れた JSON', '{'],
    ['非配列 JSON', '{"secondary":"calendar@example.com"}'],
    ['非文字列要素を含む JSON', '["secondary@example.com", 123]'],
  ])('%s は補助カレンダーなしとして扱う', async (_label, busyCalendarIds) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        calendars: {
          'primary@example.com': {
            busy: [{ start: 'primary-start', end: 'primary-end' }],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const db = stubDb(busyCalendarIds);

    await expect(getStaffGoogleBusy(db, {}, {
      lineAccountId: 'account-1',
      staffId: 'staff-1',
      timeMin: '2026-08-20T00:00:00.000Z',
      timeMax: '2026-08-21T00:00:00.000Z',
    })).resolves.toEqual([
      { start: 'primary-start', end: 'primary-end' },
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body)).items).toEqual([
      { id: 'primary@example.com' },
    ]);
    expect(db.calls[0].sql).toContain('busy_calendar_ids');
  });
});
