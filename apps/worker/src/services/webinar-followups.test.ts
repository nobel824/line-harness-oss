import { beforeEach, describe, expect, test, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  jstNow: vi.fn(() => '2026-08-10T20:00:00+09:00'),
}));
vi.mock('@line-crm/db', () => dbMocks);

const proxyMocks = vi.hoisted(() => ({
  pushViaHarnessProxy: vi.fn(),
}));
vi.mock('./line-proxy-send.js', () => proxyMocks);

const { buildJourneyFollowupText, processWebinarFollowups } =
  await import('./webinar-followups.js');

const ARCHIVE_SESSION_START = Math.floor(Date.parse('2026-08-07T20:00:00+09:00') / 1000);

function archiveCandidate(over: Record<string, unknown> = {}) {
  return {
    webinar_id: 'webinar-1',
    account_id: 'account-1',
    friend_id: 'friend-1',
    slug: 'demo',
    title: 'AI導入ライブ',
    booking_url: null,
    source_at: '2026-08-07T20:00:00+00:00',
    duration_seconds: 3420,
    last_position_seconds: null,
    form_cta_at_seconds: 2997,
    form_id: 'form-1',
    session_start_at: ARCHIVE_SESSION_START,
    ...over,
  };
}

type JourneyRow = { id: string; retry_key: string; status: 'pending' | 'sent' | 'failed' | 'skipped' };
type JourneyDbOptions = {
  archiveResults?: unknown[];
  archiveError?: Error;
  pickerResults?: unknown[];
  registeredResults?: unknown[];
  submittedResults?: unknown[];
  journeyRows?: Record<string, JourneyRow | null>;
  failArchiveInsert?: boolean;
};

function makeJourneyDb(options: JourneyDbOptions = {}) {
  const preparedSql: string[] = [];
  const inserted: Array<{ sql: string; values: unknown[] }> = [];
  const updates: Array<{ sql: string; values: unknown[] }> = [];
  const persisted = new Map<string, JourneyRow>();
  const db = {
    prepare(sql: string) {
      preparedSql.push(sql);
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async all() {
          if (sql.includes('latest_registrations')) {
            if (options.archiveError) throw options.archiveError;
            return { results: options.archiveResults ?? [] };
          }
          if (sql.includes('FROM webinar_picker_opens p')) {
            return { results: options.pickerResults ?? [] };
          }
          if (sql.includes('WITH missed AS')) {
            return { results: options.registeredResults ?? [] };
          }
          if (sql.includes('WITH submissions AS')) {
            return { results: options.submittedResults ?? [] };
          }
          return { results: [] };
        },
        async first<T>() {
          if (sql.includes('SELECT id, retry_key, status FROM webinar_journey_followups')) {
            const kind = String(values[2]);
            return (persisted.get(kind) ?? options.journeyRows?.[kind] ?? null) as T | null;
          }
          if (sql.includes('SELECT id, retry_key, status FROM webinar_followups')) {
            return null as T | null;
          }
          return null as T | null;
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO webinar_journey_followups')) {
            const kind = String(values[3]);
            if (kind === 'archive_closing' && options.failArchiveInsert) {
              throw new Error('CHECK constraint failed: webinar_journey_followups.kind');
            }
            const row: JourneyRow = {
              id: String(values[0]),
              retry_key: String(values[4]),
              status: 'pending',
            };
            persisted.set(kind, row);
            inserted.push({ sql, values: [...values] });
          } else if (sql.includes('UPDATE webinar_journey_followups')) {
            updates.push({ sql, values: [...values] });
          }
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, preparedSql, inserted, updates };
}

function prepareJourneyDeliveryMocks() {
  dbMocks.getFriendById.mockResolvedValue({
    id: 'friend-1', line_user_id: 'U1', is_following: 1,
  });
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'account-1', channel_access_token: 'tok', liff_id: 'liff-1',
  });
  proxyMocks.pushViaHarnessProxy.mockResolvedValue(undefined);
}

describe('buildJourneyFollowupText', () => {
  const pickerUrl = 'https://liff.line.me/123/?page=webinar&slug=demo';
  const bookingUrl = 'https://line.the-harness.com/t/booking';
  const admissionUrl = `https://liff.line.me/123/?page=webinar&slug=demo&sessionStartAt=${ARCHIVE_SESSION_START}&liffId=123`;

  test('未予約者には回の選択を案内する', () => {
    const text = buildJourneyFollowupText(
      'picker_no_registration', 'AI導入ライブ', pickerUrl, bookingUrl,
    );
    expect(text).toContain('20時から開催');
    expect(text).toContain(pickerUrl);
    expect(text).not.toContain(bookingUrl);
  });

  test('予約後の未視聴者には次回への選び直しを案内する', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
    );
    expect(text).toContain('選び直せます');
    expect(text).toContain(pickerUrl);
    expect(text).toContain('お送りした入場リンクから、配信のあと3日間は見返せます。');
    expect(text).not.toContain('続きがまだ残っています');
  });

  test('webinar_viewers に行が無い未視聴者はアーカイブ案内の本文になる', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      {
        lastPositionSeconds: null,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        admissionUrl: null,
      },
    );
    expect(text).toBe(
      `ご予約いただいた「AI導入ライブ」の回にお会いできませんでした。\n\n` +
      `お送りした入場リンクから、配信のあと3日間は見返せます。\n\n` +
      `同じ内容を、月・水・金・土・日の20時から開催しています。\n` +
      `都合のよい回に選び直せます👇\n${pickerUrl}\n\n` +
      `※約57分です。カメラ・マイクは使いません。`,
    );
    expect(text).not.toContain(admissionUrl);
  });

  test('admissionUrl がある未視聴者には入場リンクと別回導線を案内する', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      {
        lastPositionSeconds: null,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        admissionUrl,
      },
    );
    expect(text).toContain(`配信のあと3日間は、こちらから見返せます👇\n${admissionUrl}`);
    expect(text).toContain(pickerUrl);
    expect(text).not.toContain('お送りした入場リンクから');
  });

  test('視聴位置が0秒の registered_no_show は未参加向け本文になる', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      {
        lastPositionSeconds: 0,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        admissionUrl: null,
      },
    );
    expect(text).toContain('ご予約いただいた「AI導入ライブ」の回にお会いできませんでした。');
    expect(text).toContain(pickerUrl);
    expect(text).not.toContain('続きがまだ残っています');
  });

  test('CTA直前まで見た途中離脱者には続き案内を送り、停止位置は出さない', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      {
        lastPositionSeconds: 2996,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        admissionUrl,
      },
    );
    expect(text).toContain('「AI導入ライブ」の続きがまだ残っています。');
    expect(text).toContain(`配信のあと3日間は、こちらから続きをご覧いただけます👇\n${admissionUrl}`);
    expect(text).toContain('※残りは約7分です。');
    expect(text).not.toContain('2996');
    expect(text).not.toContain('選び直せます');
  });

  test('CTAちょうどに到達した視聴者には registered_no_show を送らない', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      {
        lastPositionSeconds: 2997,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        admissionUrl: null,
      },
    );
    expect(text).toBeNull();
  });

  test('CTAを1秒超えた視聴者にも registered_no_show を送らない', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      {
        lastPositionSeconds: 2998,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        admissionUrl: null,
      },
    );
    expect(text).toBeNull();
  });

  test('form CTA が無いウェビナーは視聴していても未視聴と同じ本文になる', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      {
        lastPositionSeconds: 1200,
        formCtaAtSeconds: null,
        durationSeconds: 3420,
        admissionUrl: null,
      },
    );
    expect(text).toContain('ご予約いただいた「AI導入ライブ」の回にお会いできませんでした。');
    expect(text).toContain('お送りした入場リンクから、配信のあと3日間は見返せます。');
    expect(text).toContain(pickerUrl);
    expect(text).not.toContain('続きがまだ残っています');
  });

  test('残り1分未満の途中離脱者は「あと少し」と出す', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      {
        lastPositionSeconds: 3370,
        formCtaAtSeconds: 3400,
        durationSeconds: 3420,
        admissionUrl: null,
      },
    );
    expect(text).toContain('※残りはあと少しです。');
    expect(text).not.toContain('3370');
  });

  test('フォーム回答後の未予約者には相談予約リンクだけを案内する', () => {
    const text = buildJourneyFollowupText(
      'submitted_no_booking_30m', 'AI導入ライブ', pickerUrl, bookingUrl,
    );
    expect(text).toContain('送信は完了');
    expect(text).toContain(bookingUrl);
    expect(text).not.toContain(pickerUrl);
  });

  // AC-5-7 / T-F: 本文はコード直書きなので、別商品向けの旧文言が
  // 再混入しても型では検出できない。4ステージ全部を機械で見張る。
  test('4ステージのどの本文にも別商品向けの旧文言が残っていない', () => {
    const kinds = [
      'picker_no_registration',
      'registered_no_show',
      'submitted_no_booking_30m',
      'submitted_no_booking_24h',
    ] as const;
    const banned = ['21分', 'AI導入診断', '15分枠', '年商', '30分間隔', 'カメラ／マイクOFF'];
    for (const kind of kinds) {
      const text = buildJourneyFollowupText(kind, 'AI導入ライブ', pickerUrl, bookingUrl);
      expect(text).not.toBeNull();
      for (const word of banned) {
        expect(text, `${kind} に「${word}」が残っている`).not.toContain(word);
      }
    }
  });

  test('AC-11-1: archive_closing の未視聴本文は期限・入場リンク・別回導線を含む', () => {
    const admissionUrl = `https://liff.line.me/123/?page=webinar&slug=demo&sessionStartAt=${ARCHIVE_SESSION_START}&liffId=123`;
    const text = buildJourneyFollowupText(
      'archive_closing',
      'AI導入ライブ',
      pickerUrl,
      null,
      {
        lastPositionSeconds: 0,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        sessionStartAt: ARCHIVE_SESSION_START,
        formId: 'form-1',
        admissionUrl,
        pickerUrl,
        consultationUrl: 'https://liff.line.me/123/?page=form&id=form-1&liffId=123',
      },
    );
    expect(text).toBe(
      `ご予約いただいた「AI導入ライブ」の入場リンクは、本日 20:57 で閉じます。\n\n` +
      `まだご覧になっていなければ、それまでにどうぞ👇\n${admissionUrl}\n\n` +
      `見る時間が取れないときは、別の回に申し込み直せます。\n` +
      `同じ内容を、月・水・金・土・日の20時から開催しています👇\n${pickerUrl}\n\n` +
      `※約57分です。カメラ・マイクは使いません。`,
    );
  });

  test('AC-11-2: archive_closing の途中離脱本文は期限・入場リンク・残り時間を含む', () => {
    const admissionUrl = `https://liff.line.me/123/?page=webinar&slug=demo&sessionStartAt=${ARCHIVE_SESSION_START}&liffId=123`;
    const text = buildJourneyFollowupText(
      'archive_closing',
      'AI導入ライブ',
      pickerUrl,
      null,
      {
        lastPositionSeconds: 1800,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        sessionStartAt: ARCHIVE_SESSION_START,
        formId: 'form-1',
        admissionUrl,
        pickerUrl,
        consultationUrl: 'https://liff.line.me/123/?page=form&id=form-1&liffId=123',
      },
    );
    expect(text).toBe(
      `「AI導入ライブ」の続きが見られるのは、本日 20:57 までです。\n\n` +
      `いちばんお伝えしたいのは終盤です。\n` +
      `Xを仕事につなげるために、最後に何から手をつけるかの話をしています。\n\n` +
      `続きはこちらから👇\n${admissionUrl}\n\n` +
      `※残りは約27分です。`,
    );
  });

  test('AC-11-3: archive_closing の完走本文は相談フォームだけを案内する', () => {
    const admissionUrl = `https://liff.line.me/123/?page=webinar&slug=demo&sessionStartAt=${ARCHIVE_SESSION_START}&liffId=123`;
    const consultationUrl = 'https://liff.line.me/123/?page=form&id=form-1&liffId=123';
    const text = buildJourneyFollowupText(
      'archive_closing',
      'AI導入ライブ',
      pickerUrl,
      null,
      {
        lastPositionSeconds: 2997,
        formCtaAtSeconds: 2997,
        durationSeconds: 3420,
        sessionStartAt: ARCHIVE_SESSION_START,
        formId: 'form-1',
        admissionUrl,
        pickerUrl,
        consultationUrl,
      },
    );
    expect(text).toBe(
      `「AI導入ライブ」を最後までご覧いただき、ありがとうございました。\n\n` +
      `終盤でご案内した無料相談は、こちらから申し込めます👇\n${consultationUrl}\n\n` +
      `tatsukiが45分、実際にあなたのXアカウントを見ながら、\n` +
      `いまどこが詰まっているかを一緒に整理します。料金はかかりません。\n\n` +
      `※日程は、フォームを送信したあとその場で選べます。`,
    );
    expect(text).not.toContain(admissionUrl);
    expect(text).not.toContain(pickerUrl);
  });

  test('AC-11-1〜3: 3分岐の本文に禁止された緊急性表現を含めない', () => {
    const common = {
      formCtaAtSeconds: 2997,
      durationSeconds: 3420,
      sessionStartAt: ARCHIVE_SESSION_START,
      formId: 'form-1',
      admissionUrl: 'https://example.com/admission',
      pickerUrl,
      consultationUrl: 'https://example.com/consultation',
    };
    const texts = [
      buildJourneyFollowupText('archive_closing', 'AI導入ライブ', pickerUrl, null, {
        ...common, lastPositionSeconds: 0,
      }),
      buildJourneyFollowupText('archive_closing', 'AI導入ライブ', pickerUrl, null, {
        ...common, lastPositionSeconds: 1800,
      }),
      buildJourneyFollowupText('archive_closing', 'AI導入ライブ', pickerUrl, null, {
        ...common, lastPositionSeconds: 2997,
      }),
    ];
    const banned = ['今すぐ', '急いで', 'もう二度と', 'もう見られなくなり'];
    for (const text of texts) {
      expect(text).not.toBeNull();
      for (const word of banned) {
        expect(text).not.toContain(word);
      }
    }
  });
});

describe('processWebinarFollowups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('AC-11-1: 未視聴の archive_closing は1行を作成して(a)を送る', async () => {
    prepareJourneyDeliveryMocks();
    const fixture = makeJourneyDb({
      archiveResults: [archiveCandidate({ last_position_seconds: 0 })],
    });

    const result = await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(fixture.inserted).toHaveLength(1);
    expect(fixture.inserted[0].values[3]).toBe('archive_closing');
    expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    const messages = proxyMocks.pushViaHarnessProxy.mock.calls[0][3] as Array<{ text: string }>;
    expect(messages[0].text).toContain('入場リンクは、本日 20:57 で閉じます。');
    expect(messages[0].text).toContain('sessionStartAt=' + ARCHIVE_SESSION_START);
    expect(messages[0].text).toContain('別の回に申し込み直せます。');
  });

  test('AC-11-3: 完走してCTA未クリックなら相談フォームURLを含む(c)を送る', async () => {
    prepareJourneyDeliveryMocks();
    const fixture = makeJourneyDb({
      archiveResults: [archiveCandidate({
        last_position_seconds: 2997,
        form_cta_at_seconds: 2997,
        form_id: 'form-1',
      })],
    });

    const result = await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 1, failed: 0 });
    const messages = proxyMocks.pushViaHarnessProxy.mock.calls[0][3] as Array<{ text: string }>;
    expect(messages[0].text).toContain(
      'https://liff.line.me/liff-1/?page=form&id=form-1&liffId=liff-1',
    );
    expect(messages[0].text).not.toContain('sessionStartAt=');
    expect(messages[0].text).not.toContain('page=webinar');
  });

  test('AC-11-4: 別セッションでCTA済みの friend は archive_closing から除外する', async () => {
    prepareJourneyDeliveryMocks();
    const fixture = makeJourneyDb({ archiveResults: [] });

    const result = await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
    const archiveSql = fixture.preparedSql.find((sql) => sql.includes('latest_registrations'));
    expect(archiveSql).toBeDefined();
    const clickedStart = archiveSql!.indexOf('SELECT 1 FROM webinar_viewers clicked');
    const clickedEnd = archiveSql!.indexOf('AND NOT EXISTS', clickedStart);
    const clickedClause = archiveSql!.slice(clickedStart, clickedEnd);
    expect(clickedClause).toContain('clicked.webinar_id = lr.webinar_id');
    expect(clickedClause).toContain('clicked.friend_id = lr.friend_id');
    expect(clickedClause).toContain('clicked.cta_clicked_at IS NOT NULL');
    expect(clickedClause).not.toContain('session_start_at');
  });

  test('archive_closing の候補SQLはstage_enabled_atを過去予約の下限に使う', async () => {
    prepareJourneyDeliveryMocks();
    const fixture = makeJourneyDb({ archiveResults: [] });

    await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    const archiveSql = fixture.preparedSql.find((sql) => sql.includes('latest_registrations'));
    expect(archiveSql).toBeDefined();
    expect(archiveSql).toContain(
      'datetime(r.created_at) >= datetime(COALESCE(cfg.stage_enabled_at, cfg.enabled_at))',
    );
  });

  test('AC-11-5: form CTA無しは(b)になり、(c)を作らず、閾値にCOALESCEを使わない', async () => {
    prepareJourneyDeliveryMocks();
    const fixture = makeJourneyDb({
      archiveResults: [archiveCandidate({
        last_position_seconds: 1200,
        form_cta_at_seconds: null,
        form_id: null,
      })],
    });

    const result = await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 1, failed: 0 });
    const messages = proxyMocks.pushViaHarnessProxy.mock.calls[0][3] as Array<{ text: string }>;
    expect(messages[0].text).toContain('続きが見られるのは、本日 20:57 までです。');
    expect(messages[0].text).not.toContain('page=form');
    const archiveSql = fixture.preparedSql.find((sql) => sql.includes('latest_registrations'));
    expect(archiveSql).toBeDefined();
    expect(archiveSql).not.toMatch(
      /COALESCE\(\s*(?:\(\s*SELECT\s+)?MIN\(wc\.at_seconds\)[\s\S]*?,\s*0\s*\)/,
    );
  });

  test('AC-11-6: 2回目の予約でも既存のarchive_closing行があれば再送しない', async () => {
    prepareJourneyDeliveryMocks();
    const fixture = makeJourneyDb({
      archiveResults: [archiveCandidate({
        session_start_at: ARCHIVE_SESSION_START + 86400,
      })],
      journeyRows: {
        archive_closing: { id: 'archive-1', retry_key: 'retry-1', status: 'sent' },
      },
    });

    const result = await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
    expect(fixture.inserted).toHaveLength(0);
    const archiveSql = fixture.preparedSql.find((sql) => sql.includes('latest_registrations'));
    const journeyStart = archiveSql!.indexOf('SELECT 1 FROM webinar_journey_followups jf');
    const journeyClause = archiveSql!.slice(journeyStart, archiveSql!.indexOf('ORDER BY', journeyStart));
    expect(journeyClause).toContain('jf.webinar_id = lr.webinar_id');
    expect(journeyClause).toContain('jf.friend_id = lr.friend_id');
    expect(journeyClause).not.toContain('session_start_at');
  });

  test('AC-11-7: archive候補SQLの例外後も既存のjourney kindを送る', async () => {
    prepareJourneyDeliveryMocks();
    const picker = {
      webinar_id: 'webinar-1',
      account_id: 'account-1',
      friend_id: 'friend-1',
      slug: 'demo',
      title: 'AI導入ライブ',
      booking_url: null,
      source_at: '2026-08-10T19:00:00+09:00',
    };
    const fixture = makeJourneyDb({
      archiveError: new Error('archive query failed'),
      pickerResults: [picker],
      journeyRows: {
        picker_no_registration: { id: 'picker-1', retry_key: 'retry-picker', status: 'pending' },
      },
    });

    const result = await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    const messages = proxyMocks.pushViaHarnessProxy.mock.calls[0][3] as Array<{ text: string }>;
    expect(messages[0].text).toContain('参加する回を選ぶ');
  });

  test('AC-11-8: migration前のkind CHECK違反でも後続のjourney送信を止めない', async () => {
    prepareJourneyDeliveryMocks();
    const picker = {
      webinar_id: 'webinar-1',
      account_id: 'account-1',
      friend_id: 'friend-1',
      slug: 'demo',
      title: 'AI導入ライブ',
      booking_url: null,
      source_at: '2026-08-10T19:00:00+09:00',
    };
    const fixture = makeJourneyDb({
      pickerResults: [picker],
      archiveResults: [archiveCandidate({ last_position_seconds: 0 })],
      failArchiveInsert: true,
      journeyRows: {
        picker_no_registration: { id: 'picker-1', retry_key: 'retry-picker', status: 'pending' },
      },
    });

    const result = await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    expect(fixture.inserted).not.toContainEqual(
      expect.objectContaining({ values: expect.arrayContaining(['archive_closing']) }),
    );
  });

  test('AC-11-10: 既存4ステージは候補0件にならず従来どおり送信する', async () => {
    prepareJourneyDeliveryMocks();
    const fixture = makeJourneyDb({
      pickerResults: [{
        webinar_id: 'webinar-1', account_id: 'account-1', friend_id: 'friend-1',
        slug: 'demo', title: 'AI導入ライブ', booking_url: null, source_at: '2026-08-10T19:00:00+09:00',
      }],
      registeredResults: [{
        webinar_id: 'webinar-1', account_id: 'account-1', friend_id: 'friend-1',
        slug: 'demo', title: 'AI導入ライブ', booking_url: null, source_at: '2026-08-10T19:00:00+09:00',
        duration_seconds: 3420, last_position_seconds: null, form_cta_at_seconds: 2997,
      }],
      submittedResults: [{
        webinar_id: 'webinar-1', account_id: 'account-1', friend_id: 'friend-1',
        slug: 'demo', title: 'AI導入ライブ', booking_url: 'https://example.com/booking',
        source_at: '2026-08-10T19:00:00+09:00',
      }],
      journeyRows: {
        picker_no_registration: { id: 'picker-1', retry_key: 'retry-picker', status: 'pending' },
        registered_no_show: { id: 'registered-1', retry_key: 'retry-registered', status: 'pending' },
        submitted_no_booking_30m: { id: 'submitted-30m', retry_key: 'retry-30m', status: 'pending' },
        submitted_no_booking_24h: { id: 'submitted-24h', retry_key: 'retry-24h', status: 'pending' },
      },
    });

    const result = await processWebinarFollowups(fixture.db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 4, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(4);
    expect(fixture.preparedSql.filter((sql) => sql.includes('FROM webinar_picker_opens p'))).not.toHaveLength(0);
    expect(fixture.preparedSql.filter((sql) => sql.includes('WITH missed AS'))).not.toHaveLength(0);
    expect(fixture.preparedSql.filter((sql) => sql.includes('WITH submissions AS'))).not.toHaveLength(0);
  });

  test('ブロック済みfriendを候補から除外し、選択後のブロックもpendingに残さない', async () => {
    const preparedSql: string[] = [];
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    const candidate = {
      webinar_id: 'webinar-1',
      account_id: 'account-1',
      friend_id: 'friend-1',
      slug: 'demo',
      form_id: 'form-1',
      cta_clicked_at: '2026-08-10T19:00:00+09:00',
    };
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return this;
          },
          async all() {
            if (sql.includes('FROM clicks c')) {
              return { results: values[1] === 'after_30m' ? [candidate] : [] };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes('SELECT id, retry_key, status FROM webinar_followups')) {
              return { id: 'followup-1', retry_key: 'retry-1', status: 'pending' };
            }
            return null;
          },
          async run() {
            updates.push({ sql, values });
            return { success: true };
          },
        };
      },
    } as unknown as D1Database;
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1', line_user_id: 'U1', is_following: 0,
    });

    const result = await processWebinarFollowups(db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(preparedSql.some((sql) =>
      sql.includes('JOIN friends f ON f.id = c.friend_id AND f.is_following = 1'),
    )).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("last_error = 'not_following'"),
      values: ['2026-08-10T20:00:00+09:00', 'followup-1'],
    }));
  });

  test('registered_no_show の候補SQLは form CTA の最小秒を COALESCE 付きで閾値にし、2997 を埋め込まない', async () => {
    const preparedSql: string[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
          async first() { return null; },
          async run() { return { success: true }; },
        };
      },
    } as unknown as D1Database;

    await processWebinarFollowups(db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    const noShowSql = preparedSql.find((sql) => sql.includes('WITH missed AS'));
    expect(noShowSql).toBeDefined();
    expect(noShowSql).toContain("wc.kind = 'form'");
    expect(noShowSql).toContain('MIN(wc.at_seconds)');
    expect(noShowSql).toContain('m.missed_session_at AS session_start_at');
    expect(noShowSql).toContain('last_position_seconds');
    expect(noShowSql).not.toContain('2997');
    // form CTA が無いウェビナーでは MIN() が NULL になり、比較が NULL に評価されて
    // 「視聴済みなのに除外されない」= 完走者に no_show が飛ぶ。COALESCE を外すと
    // モック越しのテストは全部 green のまま沈黙故障するので、SQL 文字列で縛る。
    expect(noShowSql).toMatch(/COALESCE\(\s*\(\s*SELECT MIN\(wc\.at_seconds\)/);
  });

  test('CTA到達済みの registered_no_show 候補は送らず skipped にする', async () => {
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    const candidate = {
      webinar_id: 'webinar-1',
      account_id: 'account-1',
      friend_id: 'friend-1',
      slug: 'demo',
      title: 'AI導入ライブ',
      booking_url: null,
      source_at: '2026-08-10T19:00:00+09:00',
      duration_seconds: 3420,
      last_position_seconds: 2997,
      form_cta_at_seconds: 2997,
    };
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return this;
          },
          async all() {
            if (sql.includes('WITH missed AS') && values[3] === 'registered_no_show') {
              return { results: [candidate] };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes('webinar_journey_followups')) {
              return { id: 'journey-1', retry_key: 'retry-j', status: 'pending' };
            }
            return null;
          },
          async run() {
            updates.push({ sql, values });
            return { success: true };
          },
        };
      },
    } as unknown as D1Database;
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1', line_user_id: 'U1', is_following: 1,
    });
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'account-1', channel_access_token: 'tok', liff_id: 'liff-1',
    });

    const result = await processWebinarFollowups(db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).not.toHaveBeenCalled();
    expect(updates).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("last_error = 'cta_reached'"),
      values: ['2026-08-10T20:00:00+09:00', 'journey-1'],
    }));
  });

  test('途中離脱の registered_no_show は続き案内を送る', async () => {
    const candidate = {
      webinar_id: 'webinar-1',
      account_id: 'account-1',
      friend_id: 'friend-1',
      slug: 'demo',
      title: 'AI導入ライブ',
      booking_url: null,
      source_at: '2026-08-10T19:00:00+09:00',
      duration_seconds: 3420,
      last_position_seconds: 1800,
      form_cta_at_seconds: 2997,
      session_start_at: ARCHIVE_SESSION_START,
    };
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return this;
          },
          async all() {
            if (sql.includes('WITH missed AS') && values[3] === 'registered_no_show') {
              return { results: [candidate] };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes('webinar_journey_followups')) {
              return { id: 'journey-1', retry_key: 'retry-j', status: 'pending' };
            }
            return null;
          },
          async run() {
            return { success: true };
          },
        };
      },
    } as unknown as D1Database;
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1', line_user_id: 'U1', is_following: 1,
    });
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'account-1', channel_access_token: 'tok', liff_id: 'liff-1',
    });
    proxyMocks.pushViaHarnessProxy.mockResolvedValue(undefined);

    const result = await processWebinarFollowups(db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(proxyMocks.pushViaHarnessProxy).toHaveBeenCalledTimes(1);
    const messages = proxyMocks.pushViaHarnessProxy.mock.calls[0][3] as Array<{ text: string }>;
    expect(messages[0].text).toContain('続きがまだ残っています');
    expect(messages[0].text).toContain(
      `https://liff.line.me/liff-1/?page=webinar&slug=demo&sessionStartAt=${ARCHIVE_SESSION_START}&liffId=liff-1`,
    );
    expect(messages[0].text).not.toContain('1800');
  });
});
