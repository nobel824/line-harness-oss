import { describe, expect, test, beforeEach, vi } from 'vitest';

const dbMocks = {
  getDueWebinarRegistrations: vi.fn(),
  getDueDayBeforeWebinarRegistrations: vi.fn(),
  markWebinarRegistrationNotified: vi.fn(),
  markWebinarRegistrationDayBeforeReminded: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);
// 偽タイマー下で本物の sleep を待つとテストが止まるため、送信間ジッターは潰す。
vi.mock('./stealth.js', () => ({ sleep: vi.fn().mockResolvedValue(undefined), addJitter: (min: number) => min }));

const { processWebinarReminders, sendWebinarRegistrationConfirmation, buildWebinarUrl } =
  await import('./webinar-reminders.js');

const NOW = 1_800_000_000;
const REG = {
  id: 'reg-1', webinar_id: 'w1', friend_id: 'friend-1',
  session_start_at: NOW + 240, notified_at: null, reminded_day_before_at: null, created_at: 'x',
  slug: 'test-webinar', title: 'テスト', account_id: 'acc-1', duration_seconds: 1200,
};
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const DAY_BEFORE_REG = {
  ...REG,
  id: 'reg-day-before',
  session_start_at: epoch('2026-09-05T20:00:00+09:00'),
};
const OPTIONS = {
  proxyBaseUrl: 'https://proxy.example.com/',
  defaultAccessToken: 'default-token',
  defaultLiffId: '999-def',
};
const proxyFetch = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
  dbMocks.getDueWebinarRegistrations.mockResolvedValue([]);
  dbMocks.getDueDayBeforeWebinarRegistrations.mockResolvedValue([]);
  dbMocks.getFriendById.mockResolvedValue({ id: 'friend-1', line_user_id: 'U1', is_following: 1 });
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'acc-1', channel_access_token: 'tok', liff_id: '111-aaa',
  });
  dbMocks.markWebinarRegistrationNotified.mockResolvedValue(true);
  dbMocks.markWebinarRegistrationDayBeforeReminded.mockResolvedValue(true);
  proxyFetch.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', proxyFetch);
});

describe('processWebinarReminders', () => {
  test('Harness proxy 経由で送信し、成功後に notified を刻む', async () => {
    dbMocks.getDueWebinarRegistrations.mockResolvedValue([REG]);
    const result = await processWebinarReminders({} as D1Database, OPTIONS);
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(dbMocks.getDueWebinarRegistrations).toHaveBeenCalledWith(expect.anything(), NOW, 300);
    expect(dbMocks.markWebinarRegistrationNotified).toHaveBeenCalledWith(expect.anything(), 'reg-1');
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    const [url, init] = proxyFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example.com/line-api/v2/bot/message/push');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Line-Retry-Key': 'reg-1',
    });
    const body = JSON.parse(String(init.body)) as { to: string; messages: Array<{ text: string }> };
    expect(body.to).toBe('U1');
    expect(body.messages[0].text).toContain(
      buildWebinarUrl('111-aaa', 'test-webinar', REG.session_start_at),
    );
    expect(body.messages[0].text).toContain(`sessionStartAt=${REG.session_start_at}`);
    expect(body.messages[0].text).not.toContain('配信のあと3日間は、このリンクから見返せます。');
    expect(body.messages[0].text).not.toContain('何度でも開けます');
    expect(body.messages[0].text).toContain('まもなく');
    expect(proxyFetch.mock.invocationCallOrder[0]).toBeLessThan(
      dbMocks.markWebinarRegistrationNotified.mock.invocationCallOrder[0],
    );
  });

  test('AC-4: is_internal を変えても予約リマインドの送信対象は変わらない', async () => {
    const run = async (isInternal: number) => {
      dbMocks.getDueWebinarRegistrations.mockResolvedValue([REG]);
      dbMocks.getFriendById.mockResolvedValue({
        id: 'friend-1', line_user_id: 'U1', is_following: 1, is_internal: isInternal,
      });
      proxyFetch.mockClear();
      const result = await processWebinarReminders({} as D1Database, OPTIONS);
      const body = JSON.parse(String((proxyFetch.mock.calls[0] as [string, RequestInit])[1].body)) as {
        to: string;
      };
      return { result, recipient: body.to };
    };

    const external = await run(0);
    const internal = await run(1);

    expect(internal).toEqual(external);
  });

  test('proxy 送信失敗時は notified を刻まず、次 tick で再試行できる', async () => {
    dbMocks.getDueWebinarRegistrations.mockResolvedValue([REG]);
    proxyFetch.mockResolvedValue(
      new Response('{"message":"upstream failed"}', { status: 502, statusText: 'Bad Gateway' }),
    );
    const result = await processWebinarReminders({} as D1Database, OPTIONS);
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(dbMocks.markWebinarRegistrationNotified).not.toHaveBeenCalled();
  });

  test('同じ retry key が LINE で受理済みの 409 は成功扱いにして notified を刻む', async () => {
    dbMocks.getDueWebinarRegistrations.mockResolvedValue([REG]);
    proxyFetch.mockResolvedValue(
      new Response(null, {
        status: 409,
        headers: { 'x-line-accepted-request-id': 'accepted-1' },
      }),
    );
    const result = await processWebinarReminders({} as D1Database, OPTIONS);
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(dbMocks.markWebinarRegistrationNotified).toHaveBeenCalledWith(expect.anything(), 'reg-1');
  });

  test('ブロック済み friend は送らず消化する', async () => {
    dbMocks.getDueWebinarRegistrations.mockResolvedValue([REG]);
    dbMocks.getFriendById.mockResolvedValue({ id: 'friend-1', line_user_id: 'U1', is_following: 0 });
    const result = await processWebinarReminders({} as D1Database, OPTIONS);
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(dbMocks.markWebinarRegistrationNotified).toHaveBeenCalledWith(expect.anything(), 'reg-1');
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  test('開始済みセッションは「始まりました」文言になる', async () => {
    dbMocks.getDueWebinarRegistrations.mockResolvedValue([
      { ...REG, session_start_at: NOW - 30 },
    ]);
    await processWebinarReminders({} as D1Database, OPTIONS);
    const [, init] = proxyFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ text: string }> };
    expect(body.messages[0].text).toContain('始まりました');
  });

  test('前日20時の窓に入った予約へ専用本文を送り、前日リマインド済みを刻む', async () => {
    vi.setSystemTime(new Date('2026-09-04T20:05:00+09:00'));
    dbMocks.getDueDayBeforeWebinarRegistrations.mockResolvedValue([DAY_BEFORE_REG]);

    const result = await processWebinarReminders({} as D1Database, OPTIONS);

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(dbMocks.markWebinarRegistrationDayBeforeReminded).toHaveBeenCalledWith(
      expect.anything(), DAY_BEFORE_REG.id,
    );
    const [, init] = proxyFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ text: string }> };
    expect(body.messages[0].text).toBe(
      `📅 明日 9月5日(土) 20:00 の回にご予約いただいています\n\n` +
      `「テスト」\n\n` +
      `専用の入場リンクです👇\n` +
      `${buildWebinarUrl('111-aaa', 'test-webinar', DAY_BEFORE_REG.session_start_at)}\n\n` +
      `開始5分前にも同じリンクをお送りします。\n` +
      `※約57分です。カメラ・マイクは使いません。`,
    );
    expect(init.headers).toMatchObject({ 'X-Line-Retry-Key': 'reg-day-before:day_before' });
  });

  test('同じ tick を2回処理しても前日リマインドは2通送らない', async () => {
    vi.setSystemTime(new Date('2026-09-04T20:05:00+09:00'));
    let reminded = false;
    dbMocks.getDueDayBeforeWebinarRegistrations.mockImplementation(async () => (
      reminded ? [] : [DAY_BEFORE_REG]
    ));
    dbMocks.markWebinarRegistrationDayBeforeReminded.mockImplementation(async () => {
      if (reminded) return false;
      reminded = true;
      return true;
    });

    await processWebinarReminders({} as D1Database, OPTIONS);
    await processWebinarReminders({} as D1Database, OPTIONS);

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(dbMocks.markWebinarRegistrationDayBeforeReminded).toHaveBeenCalledTimes(1);
  });

  test('前日リマインドの猶予4時間を過ぎた予約は送らずに消化する', async () => {
    vi.setSystemTime(new Date('2026-09-05T00:01:00+09:00'));
    dbMocks.getDueDayBeforeWebinarRegistrations.mockResolvedValue([DAY_BEFORE_REG]);

    const result = await processWebinarReminders({} as D1Database, OPTIONS);

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(dbMocks.markWebinarRegistrationDayBeforeReminded).toHaveBeenCalledWith(
      expect.anything(), DAY_BEFORE_REG.id,
    );
  });

  test('エポックガードより前のトリガー時刻の予約は送らず、消化もしない', async () => {
    vi.setSystemTime(new Date('2026-09-03T22:00:00+09:00'));
    const beforeEpochReg = {
      ...DAY_BEFORE_REG,
      id: 'reg-before-epoch',
      session_start_at: epoch('2026-09-04T20:00:00+09:00'),
    };
    dbMocks.getDueDayBeforeWebinarRegistrations.mockResolvedValue([beforeEpochReg]);

    const result = await processWebinarReminders({} as D1Database, OPTIONS);

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(dbMocks.markWebinarRegistrationDayBeforeReminded).not.toHaveBeenCalled();
  });

  test('1 tickの前日リマインド対象が20件を超えたら20件だけ送り、残りは次tickに回す', async () => {
    vi.setSystemTime(new Date('2026-09-04T20:05:00+09:00'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMocks.getDueDayBeforeWebinarRegistrations.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({ ...DAY_BEFORE_REG, id: `reg-${index}` })),
    );
    // 上限に当たっても、入場リンク本体の5分前は止めない。
    dbMocks.getDueWebinarRegistrations.mockResolvedValue([
      { ...REG, id: 'reg-five-minute', session_start_at: epoch('2026-09-04T20:09:00+09:00') },
    ]);

    const result = await processWebinarReminders({} as D1Database, OPTIONS);

    // 前日20件 + 5分前1件。溢れた1件は NULL のまま次 tick に回るので消化もされない。
    expect(result).toEqual({ sent: 21, failed: 0 });
    expect(proxyFetch).toHaveBeenCalledTimes(21);
    expect(dbMocks.markWebinarRegistrationDayBeforeReminded).toHaveBeenCalledTimes(20);
    expect(dbMocks.markWebinarRegistrationDayBeforeReminded).not.toHaveBeenCalledWith({}, 'reg-20');
    expect(dbMocks.markWebinarRegistrationNotified).toHaveBeenCalledWith({}, 'reg-five-minute');
    expect(error).toHaveBeenCalled();
  });

  test('上限で溢れた前日リマインドは、窓が閉じるまで消化されず次tickで送られる', async () => {
    vi.setSystemTime(new Date('2026-09-04T20:05:00+09:00'));
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const regs = Array.from({ length: 21 }, (_, index) => ({ ...DAY_BEFORE_REG, id: `reg-${index}` }))
    dbMocks.getDueDayBeforeWebinarRegistrations.mockResolvedValue(regs)

    await processWebinarReminders({} as D1Database, OPTIONS)
    expect(dbMocks.markWebinarRegistrationDayBeforeReminded).toHaveBeenCalledTimes(20)

    // 次 tick: 送信済み20件は SQL 側で外れ、残り1件だけが返る
    vi.clearAllMocks()
    proxyFetch.mockResolvedValue(new Response(null, { status: 200 }))
    vi.setSystemTime(new Date('2026-09-04T20:10:00+09:00'))
    dbMocks.getDueDayBeforeWebinarRegistrations.mockResolvedValue([regs[20]])
    dbMocks.getDueWebinarRegistrations.mockResolvedValue([])

    const result = await processWebinarReminders({} as D1Database, OPTIONS)

    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(dbMocks.markWebinarRegistrationDayBeforeReminded).toHaveBeenCalledWith({}, 'reg-20')
  });

  test('前日と5分前でX-Line-Retry-Keyを分け、5分前側の状態は従来どおり刻む', async () => {
    vi.setSystemTime(new Date('2026-09-04T20:05:00+09:00'));
    const fiveMinuteReg = {
      ...REG,
      id: 'reg-five-minute',
      session_start_at: epoch('2026-09-04T20:09:00+09:00'),
    };
    dbMocks.getDueDayBeforeWebinarRegistrations.mockResolvedValue([DAY_BEFORE_REG]);
    dbMocks.getDueWebinarRegistrations.mockResolvedValue([fiveMinuteReg]);

    await processWebinarReminders({} as D1Database, OPTIONS);

    const retryKeys = proxyFetch.mock.calls.map(([, init]) => (
      (init as RequestInit).headers as Record<string, string>
    )['X-Line-Retry-Key']);
    expect(retryKeys).toEqual(['reg-day-before:day_before', 'reg-five-minute']);
    expect(dbMocks.markWebinarRegistrationNotified).toHaveBeenCalledWith(
      expect.anything(), fiveMinuteReg.id,
    );
  });
});

describe('sendWebinarRegistrationConfirmation', () => {
  test('予約直後の確認も Harness proxy 経由で送り、履歴化する', async () => {
    await sendWebinarRegistrationConfirmation(
      {} as D1Database,
      { account_id: 'acc-1', title: 'テスト', slug: 'test-webinar' },
      'friend-1',
      NOW + 3600,
      OPTIONS,
    );
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    const [url, init] = proxyFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example.com/line-api/v2/bot/message/push');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    const body = JSON.parse(String(init.body)) as { messages: Array<{ text: string }> };
    expect(body.messages[0].text).toContain('受付しました');
    expect(body.messages[0].text).toContain(
      buildWebinarUrl('111-aaa', 'test-webinar', NOW + 3600),
    );
    expect(body.messages[0].text).toContain('専用の入場リンク');
    expect(body.messages[0].text).toContain('前日20時と、開始5分前に、同じリンクをもう一度お送りします。');
    expect(body.messages[0].text).not.toContain('配信のあと3日間は、このリンクから見返せます。');
    expect(body.messages[0].text).not.toContain('何度でも開けます');
  });
});
