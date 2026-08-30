import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import {
  getWebinarFollowupDiagnostics,
  WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES,
} from './webinar-followup-diagnostics.js';

const WEBINAR_ID = 'webinar-1';
const ENABLED_AT = '2026-08-01T00:00:00+09:00';
const NOW = '2026-08-11T20:00:00+09:00';
const FORM_ID = 'form-1';

const TEST_SCHEMA = `
  CREATE TABLE webinars (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL
  );
  CREATE TABLE friends (
    id TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL,
    is_following INTEGER NOT NULL
  );
  CREATE TABLE webinar_followup_configs (
    webinar_id TEXT PRIMARY KEY,
    enabled_at TEXT NOT NULL,
    first_delay_minutes INTEGER NOT NULL,
    second_delay_minutes INTEGER NOT NULL,
    is_active INTEGER NOT NULL,
    stage_enabled_at TEXT,
    picker_delay_minutes INTEGER NOT NULL,
    no_show_delay_minutes INTEGER NOT NULL,
    booking_delay_minutes INTEGER NOT NULL,
    booking_second_delay_minutes INTEGER NOT NULL,
    booking_menu_id TEXT,
    booking_url TEXT,
    admin_notify_line_user_id TEXT
  );
  CREATE TABLE webinar_viewers (
    id TEXT PRIMARY KEY,
    webinar_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    session_start_at INTEGER NOT NULL,
    last_position_seconds INTEGER NOT NULL,
    cta_clicked_at TEXT,
    UNIQUE (webinar_id, friend_id, session_start_at)
  );
  CREATE TABLE webinar_ctas (
    id TEXT PRIMARY KEY,
    webinar_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    form_id TEXT,
    at_seconds INTEGER NOT NULL
  );
  CREATE TABLE form_submissions (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    friend_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE webinar_followups (
    id TEXT PRIMARY KEY,
    webinar_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    retry_key TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE webinar_picker_opens (
    id TEXT PRIMARY KEY,
    webinar_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    opened_at TEXT NOT NULL
  );
  CREATE TABLE webinar_registrations (
    id TEXT PRIMARY KEY,
    webinar_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    session_start_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE webinar_journey_followups (
    id TEXT PRIMARY KEY,
    webinar_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    retry_key TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    friend_id TEXT NOT NULL,
    menu_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE meet_consultations (
    id TEXT PRIMARY KEY,
    friend_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

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
          };
        },
      };
    },
  } as unknown as D1Database;
}

function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function createSqlite(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(TEST_SCHEMA);
  sqlite
    .prepare(
      `INSERT INTO webinars (id, account_id, title, slug, duration_seconds)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(WEBINAR_ID, null, 'AI導入ライブ', 'demo', 3600);
  sqlite
    .prepare(
      `INSERT INTO webinar_followup_configs (
         webinar_id, enabled_at, first_delay_minutes, second_delay_minutes, is_active,
         stage_enabled_at, picker_delay_minutes, no_show_delay_minutes,
         booking_delay_minutes, booking_second_delay_minutes, booking_menu_id, booking_url,
         admin_notify_line_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      WEBINAR_ID,
      ENABLED_AT,
      30,
      1440,
      1,
      ENABLED_AT,
      30,
      30,
      30,
      1440,
      'menu-1',
      'https://example.com/booking',
      null,
    );
  sqlite
    .prepare(
      `INSERT INTO webinar_ctas (id, webinar_id, kind, form_id, at_seconds)
       VALUES (?, ?, 'form', ?, ?)`,
    )
    .run('form-cta-1', WEBINAR_ID, FORM_ID, 2997);
  return sqlite;
}

function insertFriend(sqlite: Database.Database, friendId: string) {
  sqlite
    .prepare(`INSERT INTO friends (id, line_user_id, is_following) VALUES (?, ?, 1)`)
    .run(friendId, `line-${friendId}`);
}

function insertViewer(
  sqlite: Database.Database,
  friendId: string,
  values: { id: string; sessionStartAt?: number; ctaClickedAt?: string | null },
) {
  sqlite
    .prepare(
      `INSERT INTO webinar_viewers (
         id, webinar_id, friend_id, session_start_at, last_position_seconds, cta_clicked_at
       ) VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(
      values.id,
      WEBINAR_ID,
      friendId,
      values.sessionStartAt ?? epoch('2026-08-11T18:00:00+09:00'),
      values.ctaClickedAt ?? null,
    );
}

function insertPickerOpen(sqlite: Database.Database, friendId: string, openedAt = '2026-08-11T18:00:00+09:00') {
  sqlite
    .prepare(
      `INSERT INTO webinar_picker_opens (id, webinar_id, friend_id, opened_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`picker-${friendId}`, WEBINAR_ID, friendId, openedAt);
}

function insertRegistration(
  sqlite: Database.Database,
  friendId: string,
  sessionStartAt: string,
  id: string,
  createdAt = sessionStartAt,
) {
  sqlite
    .prepare(
      `INSERT INTO webinar_registrations (
         id, webinar_id, friend_id, session_start_at, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, WEBINAR_ID, friendId, epoch(sessionStartAt), createdAt);
}

function insertSubmission(
  sqlite: Database.Database,
  friendId: string,
  createdAt: string,
  id = `submission-${friendId}`,
) {
  sqlite
    .prepare(
      `INSERT INTO form_submissions (id, form_id, friend_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, FORM_ID, friendId, createdAt);
}

function insertLegacyFollowup(
  sqlite: Database.Database,
  friendId: string,
  kind: string,
  status: string,
  createdAt: string,
  id = `legacy-${friendId}-${kind}`,
) {
  sqlite
    .prepare(
      `INSERT INTO webinar_followups (
         id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, WEBINAR_ID, friendId, kind, `retry-${id}`, status, createdAt, createdAt);
}

function insertJourneyFollowup(
  sqlite: Database.Database,
  friendId: string,
  kind: string,
  status: string,
  createdAt: string,
  id = `journey-${friendId}-${kind}`,
) {
  sqlite
    .prepare(
      `INSERT INTO webinar_journey_followups (
         id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, WEBINAR_ID, friendId, kind, `retry-${id}`, status, createdAt, createdAt);
}

describe('getWebinarFollowupDiagnostics', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = createSqlite();
  });

  afterEach(() => {
    sqlite.close();
  });

  test('AC-3/AC-8: 7段すべての実候補件数・母集団・行内訳・ブロッカー・判定を返す', async () => {
    for (const friendId of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']) insertFriend(sqlite, friendId);

    insertViewer(sqlite, 'f1', {
      id: 'viewer-f1',
      ctaClickedAt: '2026-08-11T18:00:00+09:00',
    });
    insertViewer(sqlite, 'f2', {
      id: 'viewer-f2',
      ctaClickedAt: '2026-08-10T18:00:00+09:00',
    });
    insertPickerOpen(sqlite, 'f3');
    insertRegistration(sqlite, 'f4', '2026-08-10T18:00:00+09:00', 'reg-f4');
    insertSubmission(sqlite, 'f5', '2026-08-11T18:00:00+09:00');
    insertSubmission(sqlite, 'f6', '2026-08-10T18:00:00+09:00');
    insertRegistration(sqlite, 'f7', '2026-08-08T23:00:00+09:00', 'reg-f7');
    insertLegacyFollowup(sqlite, 'f2', 'after_30m', 'sent', '2026-08-10T18:30:00+09:00');
    insertJourneyFollowup(
      sqlite,
      'f6',
      'submitted_no_booking_30m',
      'sent',
      '2026-08-10T18:30:00+09:00',
    );

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, { now: NOW });

    expect(diagnostics.config).toMatchObject({
      webinarId: WEBINAR_ID,
      isActive: true,
      stageEnabledAt: ENABLED_AT,
      bookingUrl: 'https://example.com/booking',
      bookingMenuId: 'menu-1',
    });
    expect(Object.keys(diagnostics.stages).sort()).toEqual([...WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES].sort());
    for (const stage of WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES) {
      expect(diagnostics.stages[stage]).toMatchObject({
        candidates: expect.any(Number),
        candidatesTruncated: false,
        population: expect.any(Number),
        rows: {
          sent: expect.any(Number),
          skipped: expect.any(Number),
          failed: expect.any(Number),
          pending: expect.any(Number),
          permanentlyBlocked: expect.any(Number),
        },
        blockers: expect.any(Array),
        verdict: expect.any(String),
      });
    }
    expect(diagnostics.stages.after_30m?.candidates).toBe(1);
    expect(diagnostics.stages.after_24h?.candidates).toBe(1);
    expect(diagnostics.stages.picker_no_registration?.candidates).toBe(1);
    expect(diagnostics.stages.registered_no_show?.candidates).toBe(2);
    expect(diagnostics.stages.submitted_no_booking_30m?.candidates).toBe(1);
    expect(diagnostics.stages.submitted_no_booking_24h?.candidates).toBe(1);
    expect(diagnostics.stages.archive_closing?.candidates).toBe(1);
  });

  test('AC-4: 母集団があっても実候補と抑止行が0なら needs_investigation にする', async () => {
    insertFriend(sqlite, 'f1');
    insertViewer(sqlite, 'f1', {
      id: 'viewer-recent',
      ctaClickedAt: '2026-08-11T19:45:00+09:00',
    });

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
      stage: 'after_30m',
    });

    expect(diagnostics.stages.after_30m).toMatchObject({
      candidates: 0,
      population: 1,
      rows: { sent: 0, skipped: 0, failed: 0, pending: 0, permanentlyBlocked: 0 },
      blockers: [],
      verdict: 'needs_investigation',
    });
  });

  test('候補が立っているステージは needs_investigation ではなく has_candidates にする', async () => {
    insertFriend(sqlite, 'f1');
    insertViewer(sqlite, 'f1', {
      id: 'viewer-due',
      ctaClickedAt: '2026-08-11T18:00:00+09:00',
    });

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
      stage: 'after_30m',
    });

    // 送信待ちを needs_investigation に混ぜると、唯一の警報が空振りする。
    expect(diagnostics.stages.after_30m).toMatchObject({
      candidates: 1,
      population: 1,
      rows: { sent: 0, skipped: 0, failed: 0, pending: 0, permanentlyBlocked: 0 },
      blockers: [],
      verdict: 'has_candidates',
    });
  });

  test('重要1: 全ウェビナー横断の候補 LIMIT で対象候補が見えないと undetermined にする', async () => {
    insertFriend(sqlite, 'target');
    insertViewer(sqlite, 'target', {
      id: 'viewer-target',
      ctaClickedAt: '2026-08-11T19:00:00+09:00',
    });

    for (let i = 1; i <= 50; i++) {
      const otherWebinarId = `other-webinar-${i}`;
      const otherFriendId = `other-friend-${i}`;
      sqlite
        .prepare(
          `INSERT INTO webinars (id, account_id, title, slug, duration_seconds)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(otherWebinarId, null, `別ウェビナー${i}`, `other-${i}`, 3600);
      sqlite
        .prepare(
          `INSERT INTO webinar_followup_configs (
             webinar_id, enabled_at, first_delay_minutes, second_delay_minutes, is_active,
             stage_enabled_at, picker_delay_minutes, no_show_delay_minutes,
             booking_delay_minutes, booking_second_delay_minutes, booking_menu_id, booking_url,
             admin_notify_line_user_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          otherWebinarId,
          ENABLED_AT,
          30,
          1440,
          1,
          ENABLED_AT,
          30,
          30,
          30,
          1440,
          'menu-1',
          'https://example.com/booking',
          null,
        );
      insertFriend(sqlite, otherFriendId);
      sqlite
        .prepare(
          `INSERT INTO webinar_ctas (id, webinar_id, kind, form_id, at_seconds)
           VALUES (?, ?, 'form', ?, ?)`,
        )
        .run(`other-form-cta-${i}`, otherWebinarId, `other-form-${i}`, 2997);
      sqlite
        .prepare(
          `INSERT INTO webinar_viewers (
             id, webinar_id, friend_id, session_start_at, last_position_seconds, cta_clicked_at
           ) VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .run(
          `other-viewer-${i}`,
          otherWebinarId,
          otherFriendId,
          epoch('2026-08-10T18:00:00+09:00'),
          '2026-08-11T18:00:00+09:00',
        );
    }

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
      stage: 'after_30m',
    });

    expect(diagnostics.stages.after_30m).toMatchObject({
      candidates: 0,
      candidatesTruncated: true,
      population: 1,
      verdict: 'undetermined',
    });
  });

  test('重要2: 7段すべての母集団からブロック中の友だちを除外する', async () => {
    insertFriend(sqlite, 'blocked');
    insertViewer(sqlite, 'blocked', {
      id: 'viewer-blocked',
      ctaClickedAt: '2026-08-11T18:00:00+09:00',
    });
    insertPickerOpen(sqlite, 'blocked');
    insertRegistration(
      sqlite,
      'blocked',
      '2026-08-11T18:00:00+09:00',
      'registration-blocked',
    );
    insertSubmission(sqlite, 'blocked', '2026-08-11T18:00:00+09:00');
    sqlite
      .prepare('UPDATE friends SET is_following = 0 WHERE id = ?')
      .run('blocked');

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
    });

    for (const stage of WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES) {
      expect(diagnostics.stages[stage]?.population, stage).toBe(0);
    }
    expect(diagnostics.stages.after_30m).toMatchObject({
      candidates: 0,
      verdict: 'no_population',
    });
  });

  test('重要2: 抑止行の実績が母集団0より先に suppressed と判定される', async () => {
    insertLegacyFollowup(
      sqlite,
      'f1',
      'after_30m',
      'sent',
      '2026-08-11T19:00:00+09:00',
    );

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
      stage: 'after_30m',
    });

    expect(diagnostics.stages.after_30m).toMatchObject({
      candidates: 0,
      population: 0,
      rows: { sent: 1, skipped: 0, permanentlyBlocked: 0 },
      verdict: 'suppressed',
    });
  });

  test('AC-5: booking_url が無い submitted stage は設定ブロッカーとして判定する', async () => {
    insertFriend(sqlite, 'f1');
    insertSubmission(sqlite, 'f1', '2026-08-11T18:00:00+09:00');
    sqlite
      .prepare('UPDATE webinar_followup_configs SET booking_url = NULL WHERE webinar_id = ?')
      .run(WEBINAR_ID);

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
      stage: 'submitted_no_booking_30m',
    });

    expect(diagnostics.stages.submitted_no_booking_30m).toMatchObject({
      candidates: 0,
      population: 1,
      blockers: ['booking_url_missing'],
      verdict: 'blocked_by_config',
    });
  });

  test('軽微2: form_id の無い form CTA は form_cta_missing と判定する', async () => {
    insertFriend(sqlite, 'f1');
    insertViewer(sqlite, 'f1', {
      id: 'viewer-form-without-id',
      ctaClickedAt: '2026-08-11T18:00:00+09:00',
    });
    sqlite
      .prepare('UPDATE webinar_ctas SET form_id = NULL WHERE webinar_id = ? AND kind = \'form\'')
      .run(WEBINAR_ID);

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
      stage: 'after_30m',
    });

    expect(diagnostics.stages.after_30m).toMatchObject({
      candidates: 0,
      population: 1,
      blockers: ['form_cta_missing'],
      verdict: 'blocked_by_config',
    });
  });

  test('AC-6: is_active=0 は7段すべてを blocked_by_config にする', async () => {
    sqlite
      .prepare('UPDATE webinar_followup_configs SET is_active = 0 WHERE webinar_id = ?')
      .run(WEBINAR_ID);

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, { now: NOW });

    for (const stage of WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES) {
      expect(diagnostics.stages[stage]?.verdict, stage).toBe('blocked_by_config');
      expect(diagnostics.stages[stage]?.blockers).toContain('config_inactive');
    }
  });

  test('AC-7: 同じ friend の複数回予約を回ごとに DISTINCT 集計し、終了状態も返す', async () => {
    insertFriend(sqlite, 'f1');
    insertFriend(sqlite, 'f2');
    insertRegistration(sqlite, 'f1', '2026-08-10T18:00:00+09:00', 'reg-session-1-f1');
    insertRegistration(sqlite, 'f2', '2026-08-10T18:00:00+09:00', 'reg-session-1-f2');
    insertRegistration(sqlite, 'f1', '2026-08-12T18:00:00+09:00', 'reg-session-2-f1');

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, { now: NOW });

    expect(diagnostics.registrationsBySession).toEqual([
      { sessionStartAt: epoch('2026-08-10T18:00:00+09:00'), friends: 2, ended: true },
      { sessionStartAt: epoch('2026-08-12T18:00:00+09:00'), friends: 1, ended: false },
    ]);
  });

  test('AC-9: 50件の実候補が LIMIT に達したら candidatesTruncated を立てる', async () => {
    for (let i = 1; i <= 50; i++) {
      const friendId = `many-${i}`;
      insertFriend(sqlite, friendId);
      insertViewer(sqlite, friendId, {
        id: `viewer-many-${i}`,
        ctaClickedAt: '2026-08-10T18:00:00+09:00',
      });
    }

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
      stage: 'after_30m',
    });

    expect(diagnostics.stages.after_30m).toMatchObject({
      candidates: 50,
      candidatesTruncated: true,
      population: 50,
    });
  });

  test('AC-10: 24時間を超えた failed/pending だけ permanentlyBlocked に数える', async () => {
    insertFriend(sqlite, 'f1');
    insertFriend(sqlite, 'f2');
    insertFriend(sqlite, 'f3');
    insertJourneyFollowup(
      sqlite,
      'f1',
      'picker_no_registration',
      'failed',
      '2026-08-10T19:00:00+09:00',
    );
    insertJourneyFollowup(
      sqlite,
      'f2',
      'picker_no_registration',
      'pending',
      '2026-08-10T19:00:00+09:00',
    );
    insertJourneyFollowup(
      sqlite,
      'f3',
      'picker_no_registration',
      'failed',
      '2026-08-11T19:30:00+09:00',
    );

    const diagnostics = await getWebinarFollowupDiagnostics(asD1(sqlite), WEBINAR_ID, {
      now: NOW,
      stage: 'picker_no_registration',
    });

    expect(diagnostics.stages.picker_no_registration?.rows).toEqual({
      sent: 0,
      skipped: 0,
      failed: 2,
      pending: 1,
      permanentlyBlocked: 2,
    });
  });
});
