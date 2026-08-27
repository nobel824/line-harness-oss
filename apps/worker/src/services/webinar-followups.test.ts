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

describe('buildJourneyFollowupText', () => {
  const pickerUrl = 'https://liff.line.me/123/?page=webinar&slug=demo';
  const bookingUrl = 'https://line.the-harness.com/t/booking';

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
      { lastPositionSeconds: null, formCtaAtSeconds: 2997, durationSeconds: 3420 },
    );
    expect(text).toContain('ご予約いただいた「AI導入ライブ」の回にお会いできませんでした。');
    expect(text).toContain('お送りした入場リンクから、配信のあと3日間は見返せます。');
    expect(text).toContain(pickerUrl);
    expect(text).not.toContain('続きがまだ残っています');
  });

  test('CTA直前まで見た途中離脱者には続き案内を送り、停止位置は出さない', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      { lastPositionSeconds: 2996, formCtaAtSeconds: 2997, durationSeconds: 3420 },
    );
    expect(text).toContain('「AI導入ライブ」の続きがまだ残っています。');
    expect(text).toContain('お送りした入場リンクから、配信のあと3日間は続きをご覧いただけます。');
    expect(text).toContain('※残りは約7分です。');
    expect(text).not.toContain('2996');
    expect(text).not.toContain('選び直せます');
    expect(text).not.toContain(pickerUrl);
  });

  test('CTAちょうどに到達した視聴者には registered_no_show を送らない', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      { lastPositionSeconds: 2997, formCtaAtSeconds: 2997, durationSeconds: 3420 },
    );
    expect(text).toBeNull();
  });

  test('CTAを1秒超えた視聴者にも registered_no_show を送らない', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      { lastPositionSeconds: 2998, formCtaAtSeconds: 2997, durationSeconds: 3420 },
    );
    expect(text).toBeNull();
  });

  test('form CTA が無いウェビナーは視聴していても未視聴と同じ本文になる', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      { lastPositionSeconds: 1200, formCtaAtSeconds: null, durationSeconds: 3420 },
    );
    expect(text).toContain('ご予約いただいた「AI導入ライブ」の回にお会いできませんでした。');
    expect(text).toContain('お送りした入場リンクから、配信のあと3日間は見返せます。');
    expect(text).toContain(pickerUrl);
    expect(text).not.toContain('続きがまだ残っています');
  });

  test('残り1分未満の途中離脱者は「あと少し」と出す', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
      { lastPositionSeconds: 3370, formCtaAtSeconds: 3400, durationSeconds: 3420 },
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
});

describe('processWebinarFollowups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  test('registered_no_show の候補SQLは form CTA の最小秒を閾値にし、2997 を埋め込まない', async () => {
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
    expect(noShowSql).toContain('last_position_seconds');
    expect(noShowSql).not.toContain('2997');
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
            if (sql.includes('WITH missed AS') && values[2] === 'registered_no_show') {
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
            if (sql.includes('WITH missed AS') && values[2] === 'registered_no_show') {
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
    expect(messages[0].text).not.toContain('1800');
  });
});
