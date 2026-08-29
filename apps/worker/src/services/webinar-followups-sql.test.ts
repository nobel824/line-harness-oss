import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';

const dbMocks = vi.hoisted(() => ({
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  jstNow: vi.fn(() => '2026-08-11T20:00:00+09:00'),
}));
vi.mock('@line-crm/db', () => dbMocks);

const proxyMocks = vi.hoisted(() => ({
  pushViaHarnessProxy: vi.fn(),
}));
vi.mock('./line-proxy-send.js', () => proxyMocks);

const { processWebinarFollowups } = await import('./webinar-followups.js');

const WEBINAR_ID = 'webinar-1';
const FRIEND_ID = 'friend-1';
const NOW = '2026-08-11T20:00:00+09:00';
const ENABLED_AT = '2026-08-01T00:00:00+09:00';
const FORM_CTA_ID = 'form-cta-1';
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
    booking_url TEXT
  );
  CREATE TABLE webinar_viewers (
    id TEXT PRIMARY KEY,
    webinar_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    session_start_at INTEGER NOT NULL,
    last_position_seconds INTEGER NOT NULL,
    cta_clicked_at TEXT
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
    sent_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (webinar_id, friend_id, kind)
  );
  CREATE TABLE webinar_picker_opens (
    id TEXT PRIMARY KEY,
    webinar_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    UNIQUE (webinar_id, friend_id)
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
    sent_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (webinar_id, friend_id, kind)
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

function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function createSqlite(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(TEST_SCHEMA);
  sqlite.prepare(
    `INSERT INTO webinars (id, account_id, title, slug, duration_seconds)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(WEBINAR_ID, null, 'AI導入ライブ', 'demo', 3449);
  sqlite.prepare(
    `INSERT INTO friends (id, line_user_id, is_following) VALUES (?, ?, ?)`,
  ).run(FRIEND_ID, 'U1', 1);
  sqlite.prepare(
    `INSERT INTO webinar_followup_configs (
       webinar_id, enabled_at, first_delay_minutes, second_delay_minutes, is_active,
       stage_enabled_at, picker_delay_minutes, no_show_delay_minutes,
       booking_delay_minutes, booking_second_delay_minutes, booking_menu_id, booking_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  );
  sqlite.prepare(
    `INSERT INTO webinar_ctas (id, webinar_id, kind, form_id, at_seconds)
     VALUES (?, ?, 'form', ?, ?)`,
  ).run(FORM_CTA_ID, WEBINAR_ID, FORM_ID, 2997);
  return sqlite;
}

function updateConfig(
  sqlite: Database.Database,
  values: Partial<{
    stage_enabled_at: string | null;
    picker_delay_minutes: number;
    no_show_delay_minutes: number;
    booking_delay_minutes: number;
    booking_second_delay_minutes: number;
    booking_menu_id: string | null;
    booking_url: string | null;
    first_delay_minutes: number;
    second_delay_minutes: number;
  }>,
) {
  const entries = Object.entries(values);
  if (entries.length === 0) return;
  const sets = entries.map(([column]) => `${column} = ?`).join(', ');
  sqlite
    .prepare(`UPDATE webinar_followup_configs SET ${sets} WHERE webinar_id = ?`)
    .run(...entries.map(([, value]) => value), WEBINAR_ID);
}

function insertViewer(
  sqlite: Database.Database,
  values: {
    id?: string;
    sessionStartAt?: number;
    lastPositionSeconds?: number;
    ctaClickedAt?: string | null;
  } = {},
) {
  sqlite.prepare(
    `INSERT INTO webinar_viewers (
       id, webinar_id, friend_id, session_start_at, last_position_seconds, cta_clicked_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id ?? 'viewer-1',
    WEBINAR_ID,
    FRIEND_ID,
    values.sessionStartAt ?? epoch('2026-08-11T19:00:00+09:00'),
    values.lastPositionSeconds ?? 0,
    values.ctaClickedAt ?? null,
  );
}

function insertCtaFollowup(
  sqlite: Database.Database,
  kind: string,
  status: string,
  createdAt: string,
  id = `followup-${kind}`,
) {
  sqlite.prepare(
    `INSERT INTO webinar_followups (
       id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, WEBINAR_ID, FRIEND_ID, kind, `retry-${kind}`, status, createdAt, createdAt);
}

function insertSubmission(
  sqlite: Database.Database,
  createdAt: string,
  id = 'submission-1',
) {
  sqlite.prepare(
    `INSERT INTO form_submissions (id, form_id, friend_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, FORM_ID, FRIEND_ID, createdAt);
}

function insertJourneyFollowup(
  sqlite: Database.Database,
  kind: string,
  status: string,
  createdAt: string,
  id = `journey-${kind}`,
) {
  sqlite.prepare(
    `INSERT INTO webinar_journey_followups (
       id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, WEBINAR_ID, FRIEND_ID, kind, `retry-${kind}`, status, createdAt, createdAt);
}

function insertRegistration(
  sqlite: Database.Database,
  sessionStartAt: string,
  id = 'registration-1',
) {
  sqlite.prepare(
    `INSERT INTO webinar_registrations (
       id, webinar_id, friend_id, session_start_at, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, WEBINAR_ID, FRIEND_ID, epoch(sessionStartAt), sessionStartAt);
}

function prepareDeliveryMocks() {
  dbMocks.jstNow.mockReturnValue(NOW);
  dbMocks.getFriendById.mockResolvedValue({
    id: FRIEND_ID,
    line_user_id: 'U1',
    is_following: 1,
  });
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'account-1',
    channel_access_token: 'token',
    liff_id: 'liff-1',
  });
  proxyMocks.pushViaHarnessProxy.mockResolvedValue(undefined);
}

async function processOn(
  sqlite: Database.Database,
  now = NOW,
): Promise<{ sent: number; failed: number }> {
  dbMocks.jstNow.mockReturnValue(now);
  return processWebinarFollowups(asD1(sqlite), {
    proxyBaseUrl: 'https://proxy.example.com',
    defaultAccessToken: 'token',
    defaultLiffId: 'liff-1',
  });
}

type JourneyKind =
  | 'picker_no_registration'
  | 'registered_no_show'
  | 'submitted_no_booking_30m'
  | 'submitted_no_booking_24h'
  | 'archive_closing';

function seedJourneyStage(sqlite: Database.Database, kind: JourneyKind) {
  switch (kind) {
    case 'picker_no_registration':
      sqlite.prepare(
        `INSERT INTO webinar_picker_opens (id, webinar_id, friend_id, opened_at)
         VALUES (?, ?, ?, ?)`,
      ).run('picker-1', WEBINAR_ID, FRIEND_ID, '2026-08-11T18:00:00+09:00');
      return;
    case 'registered_no_show':
      insertRegistration(sqlite, '2026-08-11T18:00:00+09:00');
      return;
    case 'submitted_no_booking_30m':
      insertSubmission(sqlite, '2026-08-11T19:00:00+09:00');
      return;
    case 'submitted_no_booking_24h':
      insertSubmission(sqlite, '2026-08-10T18:00:00+09:00');
      insertJourneyFollowup(
        sqlite,
        'submitted_no_booking_30m',
        'sent',
        '2026-08-10T18:00:00+09:00',
        'journey-submitted-30m',
      );
      return;
    case 'archive_closing':
      insertRegistration(sqlite, '2026-08-08T23:00:00+09:00');
      insertViewer(sqlite, {
        sessionStartAt: epoch('2026-08-08T23:00:00+09:00'),
        lastPositionSeconds: 2997,
      });
      return;
  }
}

describe('webinar follow-up candidate SQL', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    prepareDeliveryMocks();
    sqlite = createSqlite();
  });

  afterEach(() => {
    sqlite.close();
  });

  test('T1: journey 5種は failed/pending の24時間以内だけ再候補にし、sent/skippedと期限超過を止める', async () => {
    const cases = [
      { status: 'failed', createdAt: '2026-08-10T21:00:00+09:00', expectedSent: 1 },
      { status: 'pending', createdAt: '2026-08-10T21:00:00+09:00', expectedSent: 1 },
      { status: 'sent', createdAt: '2026-08-11T19:30:00+09:00', expectedSent: 0 },
      { status: 'skipped', createdAt: '2026-08-11T19:30:00+09:00', expectedSent: 0 },
      { status: 'failed', createdAt: '2026-08-10T18:00:00+09:00', expectedSent: 0 },
      { status: 'pending', createdAt: '2026-08-10T18:00:00+09:00', expectedSent: 0 },
    ] as const;
    const journeyKinds: JourneyKind[] = [
      'picker_no_registration',
      'registered_no_show',
      'submitted_no_booking_30m',
      'submitted_no_booking_24h',
      'archive_closing',
    ];

    for (const kind of journeyKinds) {
      for (const scenario of cases) {
        vi.clearAllMocks();
        prepareDeliveryMocks();
        const scenarioDb = createSqlite();
        seedJourneyStage(scenarioDb, kind);
        insertJourneyFollowup(
          scenarioDb,
          kind,
          scenario.status,
          scenario.createdAt,
          `journey-${kind}-${scenario.status}-${scenario.createdAt}`,
        );
        try {
          const result = await processOn(scenarioDb);
          expect(result, `${kind}/${scenario.status}/${scenario.createdAt}`).toEqual({
            sent: scenario.expectedSent,
            failed: 0,
          });
          expect(
            proxyMocks.pushViaHarnessProxy,
            `${kind}/${scenario.status}/${scenario.createdAt}`,
          ).toHaveBeenCalledTimes(scenario.expectedSent);
        } finally {
          scenarioDb.close();
        }
      }
    }
  });

  test('T2: after_30m はform CTAから未送信だけを候補にする', async () => {
    insertViewer(sqlite, { ctaClickedAt: '2026-08-11T19:00:00+09:00' });
    let result = await processOn(sqlite);
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    const messages = proxyMocks.pushViaHarnessProxy.mock.calls[0][3] as Array<{ text: string }>;
    expect(messages[0].text).toContain('入力の途中で止まっているようです。');

    vi.clearAllMocks();
    prepareDeliveryMocks();
    const submittedDb = createSqlite();
    updateConfig(submittedDb, { booking_delay_minutes: 9999 });
    insertViewer(submittedDb, { ctaClickedAt: '2026-08-11T19:00:00+09:00' });
    insertSubmission(submittedDb, '2026-08-11T19:30:00+09:00');
    try {
      result = await processOn(submittedDb);
      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
    } finally {
      submittedDb.close();
    }
  });

  test('T3: submitted_no_booking_24h はsubmitted_no_booking_30m sent後だけ候補にする', async () => {
    updateConfig(sqlite, { booking_delay_minutes: 9999 });
    insertSubmission(sqlite, '2026-08-10T18:00:00+09:00');
    let result = await processOn(sqlite);
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();

    vi.clearAllMocks();
    prepareDeliveryMocks();
    const firstSentDb = createSqlite();
    updateConfig(firstSentDb, { booking_delay_minutes: 9999 });
    insertSubmission(firstSentDb, '2026-08-10T18:00:00+09:00');
    insertJourneyFollowup(
      firstSentDb,
      'submitted_no_booking_30m',
      'sent',
      '2026-08-10T18:00:00+09:00',
      'journey-first-sent',
    );
    try {
      result = await processOn(firstSentDb);
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
      const messages = proxyMocks.pushViaHarnessProxy.mock.calls[0][3] as Array<{ text: string }>;
      expect(messages[0].text).toContain('昨日ご入力いただいた無料相談');
    } finally {
      firstSentDb.close();
    }
  });

  test("T3': after_24h はafter_30m sent後だけ候補にする", async () => {
    const ctaClickedAt = '2026-08-10T19:00:00+09:00';
    updateConfig(sqlite, { first_delay_minutes: 9999, second_delay_minutes: 1440 });
    insertViewer(sqlite, { ctaClickedAt });

    let result = await processOn(sqlite);
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();

    vi.clearAllMocks();
    prepareDeliveryMocks();
    const firstSentDb = createSqlite();
    updateConfig(firstSentDb, { first_delay_minutes: 9999, second_delay_minutes: 1440 });
    insertViewer(firstSentDb, { ctaClickedAt });
    insertCtaFollowup(firstSentDb, 'after_30m', 'sent', ctaClickedAt, 'cta-first-sent');
    try {
      result = await processOn(firstSentDb);
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
      const messages = proxyMocks.pushViaHarnessProxy.mock.calls[0][3] as Array<{ text: string }>;
      expect(messages[0].text).toBe(
        '昨日ご案内した無料相談は、入力の途中から再開できます。\n\n' +
        'お聞きするのは、XのアカウントID（@から始まるもの）と' +
        'いま一番詰まっていると感じるところの2つです。\n' +
        '送信すると、そのまま空いている日時をお選びいただけます👇\n' +
        'https://liff.line.me/liff-1/?page=form&id=form-1&liffId=liff-1\n\n' +
        'ご案内はこれで最後です。',
      );
    } finally {
      firstSentDb.close();
    }
  });

  test('T4: after_* はstage_enabled_atを門にし、NULLならenabled_atへフォールバックする', async () => {
    const kinds = ['after_30m', 'after_24h'] as const;
    for (const kind of kinds) {
      vi.clearAllMocks();
      prepareDeliveryMocks();
      const beforeStageDb = createSqlite();
      updateConfig(beforeStageDb, {
        stage_enabled_at: '2026-08-11T19:30:00+09:00',
        first_delay_minutes: kind === 'after_30m' ? 30 : 9999,
        second_delay_minutes: kind === 'after_24h' ? 0 : 9999,
      });
      insertViewer(beforeStageDb, { ctaClickedAt: '2026-08-11T19:00:00+09:00' });
      if (kind === 'after_24h') {
        insertCtaFollowup(beforeStageDb, 'after_30m', 'sent', '2026-08-11T19:00:00+09:00');
      }
      try {
        const result = await processOn(beforeStageDb);
        expect(result, `${kind} before stage_enabled_at`).toEqual({ sent: 0, failed: 0 });
        expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
      } finally {
        beforeStageDb.close();
      }

      vi.clearAllMocks();
      prepareDeliveryMocks();
      const fallbackDb = createSqlite();
      updateConfig(fallbackDb, {
        stage_enabled_at: null,
        first_delay_minutes: kind === 'after_30m' ? 30 : 9999,
        second_delay_minutes: kind === 'after_24h' ? 0 : 9999,
      });
      insertViewer(fallbackDb, { ctaClickedAt: '2026-08-11T19:00:00+09:00' });
      if (kind === 'after_24h') {
        insertCtaFollowup(fallbackDb, 'after_30m', 'sent', '2026-08-11T19:00:00+09:00');
      }
      try {
        const result = await processOn(fallbackDb);
        expect(result, `${kind} fallback to enabled_at`).toEqual({ sent: 1, failed: 0 });
        expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
      } finally {
        fallbackDb.close();
      }
    }
  });

  test('T5: after_* はform CTAが無い(url CTAだけの)ウェビナーを候補にしない', async () => {
    const kinds = ['after_30m', 'after_24h'] as const;
    for (const kind of kinds) {
      vi.clearAllMocks();
      prepareDeliveryMocks();
      const scenarioDb = createSqlite();
      updateConfig(scenarioDb, {
        first_delay_minutes: kind === 'after_30m' ? 30 : 9999,
        second_delay_minutes: kind === 'after_24h' ? 0 : 9999,
      });
      scenarioDb.prepare('DELETE FROM webinar_ctas WHERE webinar_id = ?').run(WEBINAR_ID);
      scenarioDb.prepare(
        `INSERT INTO webinar_ctas (id, webinar_id, kind, form_id, at_seconds)
         VALUES (?, ?, 'url', NULL, ?)`,
      ).run('url-cta-1', WEBINAR_ID, 100);
      insertViewer(scenarioDb, { ctaClickedAt: '2026-08-11T19:00:00+09:00' });
      try {
        const result = await processOn(scenarioDb);
        expect(result, kind).toEqual({ sent: 0, failed: 0 });
        expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
      } finally {
        scenarioDb.close();
      }
    }
  });

  test('T6: registered_no_show は回の終了後だけ候補にし、1380分設定の挙動を保つ', async () => {
    const beforeEndDb = createSqlite();
    insertRegistration(beforeEndDb, '2026-08-11T19:00:00+09:00');
    try {
      const result = await processOn(beforeEndDb, '2026-08-11T19:30:00+09:00');
      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
    } finally {
      beforeEndDb.close();
    }

    vi.clearAllMocks();
    prepareDeliveryMocks();
    const afterEndDb = createSqlite();
    insertRegistration(afterEndDb, '2026-08-11T19:00:00+09:00');
    try {
      const result = await processOn(afterEndDb, NOW);
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    } finally {
      afterEndDb.close();
    }

    vi.clearAllMocks();
    prepareDeliveryMocks();
    const productionConfigDb = createSqlite();
    updateConfig(productionConfigDb, { no_show_delay_minutes: 1380 });
    insertRegistration(productionConfigDb, '2026-08-10T20:00:00+09:00');
    try {
      const result = await processOn(productionConfigDb, NOW);
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    } finally {
      productionConfigDb.close();
    }
  });

  test('T7: submitted_no_booking_30m はbooking_urlとbooking_menu_idが両方ある場合だけ候補にする', async () => {
    const cases = [
      { booking_url: null, booking_menu_id: 'menu-1', expectedSent: 0 },
      { booking_url: 'https://example.com/booking', booking_menu_id: null, expectedSent: 0 },
      { booking_url: 'https://example.com/booking', booking_menu_id: 'menu-1', expectedSent: 1 },
    ] as const;
    for (const scenario of cases) {
      vi.clearAllMocks();
      prepareDeliveryMocks();
      const scenarioDb = createSqlite();
      updateConfig(scenarioDb, {
        booking_url: scenario.booking_url,
        booking_menu_id: scenario.booking_menu_id,
      });
      insertSubmission(scenarioDb, '2026-08-11T19:00:00+09:00');
      try {
        const result = await processOn(scenarioDb);
        expect(result, JSON.stringify(scenario)).toEqual({
          sent: scenario.expectedSent,
          failed: 0,
        });
        expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(scenario.expectedSent);
      } finally {
        scenarioDb.close();
      }
    }
  });

  test('T8: submitted_no_booking_30m は有効予約が無い場合だけ候補にする', async () => {
    const cases = [
      { status: 'requested', expectedSent: 0 },
      { status: 'confirmed', expectedSent: 0 },
      { status: 'completed', expectedSent: 0 },
      { status: 'cancelled', expectedSent: 1 },
    ] as const;
    for (const scenario of cases) {
      vi.clearAllMocks();
      prepareDeliveryMocks();
      const scenarioDb = createSqlite();
      insertSubmission(scenarioDb, '2026-08-11T19:00:00+09:00');
      scenarioDb.prepare(
        `INSERT INTO bookings (id, friend_id, menu_id, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        `booking-${scenario.status}`,
        FRIEND_ID,
        'menu-1',
        scenario.status,
        '2026-08-11T19:30:00+09:00',
      );
      try {
        const result = await processOn(scenarioDb);
        expect(result, scenario.status).toEqual({ sent: scenario.expectedSent, failed: 0 });
        expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(scenario.expectedSent);
      } finally {
        scenarioDb.close();
      }
    }
  });

  test('T9: picker_no_registration はstage_enabled_atより前のopened_atを候補にしない', async () => {
    updateConfig(sqlite, { stage_enabled_at: '2026-08-11T19:30:00+09:00' });
    sqlite.prepare(
      `INSERT INTO webinar_picker_opens (id, webinar_id, friend_id, opened_at)
       VALUES (?, ?, ?, ?)`,
    ).run('picker-1', WEBINAR_ID, FRIEND_ID, '2026-08-11T19:00:00+09:00');

    const result = await processOn(sqlite);
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
  });

  test('T10: archive_closing はアーカイブ期限を過ぎると候補にせず、期限内は候補にする', async () => {
    insertRegistration(sqlite, '2026-08-07T20:00:00+09:00');
    insertViewer(sqlite, {
      sessionStartAt: epoch('2026-08-07T20:00:00+09:00'),
      lastPositionSeconds: 2997,
    });

    let result = await processOn(sqlite);
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();

    vi.clearAllMocks();
    prepareDeliveryMocks();
    const withinWindowDb = createSqlite();
    insertRegistration(withinWindowDb, '2026-08-08T23:00:00+09:00');
    insertViewer(withinWindowDb, {
      sessionStartAt: epoch('2026-08-08T23:00:00+09:00'),
      lastPositionSeconds: 2997,
    });
    try {
      result = await processOn(withinWindowDb);
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    } finally {
      withinWindowDb.close();
    }
  });

  test('T11: submitted_no_booking_24h は送信予定時刻から24時間を過ぎると候補にしない', async () => {
    const overdueDb = createSqlite();
    updateConfig(overdueDb, { booking_delay_minutes: 9999 });
    seedJourneyStage(overdueDb, 'submitted_no_booking_24h');
    try {
      const result = await processOn(overdueDb, '2026-08-12T18:01:00+09:00');
      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
    } finally {
      overdueDb.close();
    }

    vi.clearAllMocks();
    prepareDeliveryMocks();
    const withinWindowDb = createSqlite();
    updateConfig(withinWindowDb, { booking_delay_minutes: 9999 });
    seedJourneyStage(withinWindowDb, 'submitted_no_booking_24h');
    try {
      const result = await processOn(withinWindowDb, '2026-08-11T18:01:00+09:00');
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    } finally {
      withinWindowDb.close();
    }
  });

  test('T12: after_24h は送信予定時刻から24時間を過ぎると候補にしない', async () => {
    const ctaClickedAt = '2026-08-10T19:00:00+09:00';

    const overdueDb = createSqlite();
    updateConfig(overdueDb, { first_delay_minutes: 9999, second_delay_minutes: 1440 });
    insertViewer(overdueDb, { ctaClickedAt });
    insertCtaFollowup(overdueDb, 'after_30m', 'sent', ctaClickedAt, 'cta-overdue-first-sent');
    try {
      const result = await processOn(overdueDb, '2026-08-12T19:01:00+09:00');
      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
    } finally {
      overdueDb.close();
    }

    vi.clearAllMocks();
    prepareDeliveryMocks();
    const withinWindowDb = createSqlite();
    updateConfig(withinWindowDb, { first_delay_minutes: 9999, second_delay_minutes: 1440 });
    insertViewer(withinWindowDb, { ctaClickedAt });
    insertCtaFollowup(withinWindowDb, 'after_30m', 'sent', ctaClickedAt, 'cta-within-first-sent');
    try {
      const result = await processOn(withinWindowDb, '2026-08-11T19:01:00+09:00');
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    } finally {
      withinWindowDb.close();
    }
  });

  test('T13: after_24h はafter_30mがfailedなら候補にしない', async () => {
    const ctaClickedAt = '2026-08-11T19:00:00+09:00';
    updateConfig(sqlite, { first_delay_minutes: 9999, second_delay_minutes: 0 });
    insertViewer(sqlite, { ctaClickedAt });
    insertCtaFollowup(sqlite, 'after_30m', 'failed', ctaClickedAt);

    const result = await processOn(sqlite, '2026-08-11T20:00:00+09:00');
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
  });
});
