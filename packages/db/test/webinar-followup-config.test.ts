import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import {
  getWebinarFollowupConfig,
  upsertWebinarFollowupConfig,
} from '../src/webinars.js';

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(sql);
          return {
            async first<T>() {
              return (statement.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { success: true, results: statement.all(...params) as T[], meta: {} };
            },
            async run() {
              const result = statement.run(...params);
              return {
                success: true,
                meta: { changes: result.changes, last_row_id: result.lastInsertRowid },
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('webinar follow-up config helpers', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(
      'CREATE TABLE webinar_followup_configs (' +
      'webinar_id TEXT PRIMARY KEY, ' +
      'enabled_at TEXT NOT NULL, ' +
      'first_delay_minutes INTEGER NOT NULL DEFAULT 30, ' +
      'second_delay_minutes INTEGER NOT NULL DEFAULT 1440, ' +
      'is_active INTEGER NOT NULL DEFAULT 1, ' +
      'stage_enabled_at TEXT, ' +
      'picker_delay_minutes INTEGER NOT NULL DEFAULT 30, ' +
      'no_show_delay_minutes INTEGER NOT NULL DEFAULT 30, ' +
      'booking_delay_minutes INTEGER NOT NULL DEFAULT 30, ' +
      'booking_second_delay_minutes INTEGER NOT NULL DEFAULT 1440, ' +
      'booking_menu_id TEXT, ' +
      'booking_url TEXT, ' +
      'admin_notify_line_user_id TEXT)',
    );
  });

  afterEach(() => sqlite.close());

  test('行が無い場合は安全な初期値で作成できる', async () => {
    const config = await upsertWebinarFollowupConfig(asD1(sqlite), 'webinar-1', {
      isActive: true,
      stageEnabledAt: '2026-08-28T12:34:56.000+09:00',
      bookingMenuId: 'menu-1',
      bookingUrl: 'https://example.com/booking',
      adminNotifyLineUserId: 'UADMIN',
    });

    expect(config).toMatchObject({
      webinar_id: 'webinar-1',
      first_delay_minutes: 30,
      second_delay_minutes: 1440,
      is_active: 1,
      stage_enabled_at: '2026-08-28T12:34:56.000+09:00',
      booking_menu_id: 'menu-1',
      booking_url: 'https://example.com/booking',
      admin_notify_line_user_id: 'UADMIN',
    });
    expect(config.enabled_at).toMatch(/T/);
  });

  test('部分更新では指定していない設定を保持する', async () => {
    const db = asD1(sqlite);
    await upsertWebinarFollowupConfig(db, 'webinar-1', {
      isActive: true,
      stageEnabledAt: '2026-08-28T12:34:56.000+09:00',
      bookingMenuId: 'menu-1',
      bookingUrl: 'https://example.com/booking',
      adminNotifyLineUserId: 'UADMIN',
    });

    const updated = await upsertWebinarFollowupConfig(db, 'webinar-1', {
      bookingUrl: null,
    });

    expect(updated).toMatchObject({
      webinar_id: 'webinar-1',
      is_active: 1,
      stage_enabled_at: '2026-08-28T12:34:56.000+09:00',
      booking_menu_id: 'menu-1',
      booking_url: null,
      admin_notify_line_user_id: 'UADMIN',
    });
    expect(await getWebinarFollowupConfig(db, 'webinar-1')).toEqual(updated);
  });

  test('noShowDelayMinutes は作成時と部分更新時に保存できる', async () => {
    const db = asD1(sqlite);
    const stageEnabledAt = '2026-08-28T12:34:56.000+09:00';
    const created = await upsertWebinarFollowupConfig(db, 'webinar-1', {
      noShowDelayMinutes: 90,
      stageEnabledAt,
    });

    expect(created.no_show_delay_minutes).toBe(90);
    expect(created.stage_enabled_at).toBe(stageEnabledAt);

    const updated = await upsertWebinarFollowupConfig(db, 'webinar-1', {
      noShowDelayMinutes: 120,
    });

    expect(updated.no_show_delay_minutes).toBe(120);
    expect(updated.stage_enabled_at).toBe(stageEnabledAt);
  });
});
