import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = {
  getLineAccounts: vi.fn(), getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(), recoverStuckDeliveries: vi.fn(),
  getFriendByLineUserId: vi.fn(), getFriendByLineUserIdForAccount: vi.fn(),
  upsertFriend: vi.fn(), createUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
  getUserByEmail: vi.fn().mockResolvedValue(null), linkFriendToUser: vi.fn(),
  getEntryRouteByRefCode: vi.fn(), getTrackedLinkById: vi.fn(),
  getAffiliateLinkByRefCode: vi.fn(), getAffiliateOfferById: vi.fn(),
  getAffiliateById: vi.fn(), getLineAccountByChannelId: vi.fn(),
  getLineAccountById: vi.fn(), getScenarios: vi.fn().mockResolvedValue([]),
  enrollFriendInScenario: vi.fn(), recordRefTracking: vi.fn(),
};
vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  dbMocks.recordRefTracking.mockImplementation(actual.recordRefTracking);
  return { ...actual, ...dbMocks };
});
const attachTagAndFireSideEffects = vi.fn();
const pushImmediateFirstStep = vi.fn();
const notifyAffiliateFriendAdd = vi.fn();
vi.mock('../services/friend-tag-attach.js', () => ({ attachTagAndFireSideEffects }));
vi.mock('../services/immediate-first-step.js', () => ({ pushImmediateFirstStep }));
vi.mock('../services/affiliate-notifier.js', () => ({ notifyAffiliateFriendAdd }));
const worker = (await import('../index.js')).default;

const REF = 'sagarifuji-threads';
const SAGA = { id: 'account-saga', channel_id: '2011217182', login_channel_id: 'saga-login' };
const OTHER = { id: 'account-other', channel_id: 'other-channel', login_channel_id: 'other-login' };
let sqlite: Database.Database;
let verifiedLogin = SAGA.login_channel_id;
let env: import('../index.js').Env['Bindings'];

function friend() {
  return sqlite.prepare('SELECT * FROM friends WHERE id = ?').get('friend-1');
}

function call(path: string, body?: object) {
  return worker.fetch(new Request(`https://worker.example${path}`, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}

function assertNoCampaign() {
  expect(attachTagAndFireSideEffects).not.toHaveBeenCalled();
  expect(pushImmediateFirstStep).not.toHaveBeenCalled();
  expect(notifyAffiliateFriendAdd).not.toHaveBeenCalled();
  expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  const fetchMock = vi.mocked(fetch);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/message/'))).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE friends (id TEXT PRIMARY KEY, line_user_id TEXT, line_account_id TEXT,
      user_id TEXT, ref_code TEXT, last_ref_code TEXT, last_ref_at TEXT, metadata TEXT);
    INSERT INTO friends VALUES ('friend-1', 'line-user-1', 'account-saga', 'user-1', NULL, NULL, NULL, '{}');
    CREATE TABLE ref_tracking (id TEXT PRIMARY KEY, ref_code TEXT, friend_id TEXT,
      entry_route_id TEXT, source_url TEXT, fbclid TEXT, gclid TEXT, twclid TEXT,
      ttclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
      user_agent TEXT, ip_address TEXT, created_at TEXT);
    CREATE TABLE line_accounts (id TEXT, login_channel_id TEXT, is_active INTEGER,
      channel_access_token TEXT);
  `);
  const DB = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const bound = (values: unknown[] = []) => ({
        run: async () => ({ meta: { changes: statement.run(...values).changes } }),
        first: async () => statement.get(...values) ?? null,
        all: async () => ({ results: statement.all(...values) }),
      });
      return { ...bound(), bind: (...values: unknown[]) => bound(values) };
    },
  } as unknown as D1Database;
  env = { DB, LINE_LOGIN_CHANNEL_ID: 'default-login', LINE_LOGIN_CHANNEL_SECRET: 'fixture',
    LIFF_URL: 'https://liff.line.me/1000000000-Fixture', WORKER_URL: 'https://worker.example' } as typeof env;
  verifiedLogin = SAGA.login_channel_id;
  dbMocks.getLineAccounts.mockResolvedValue([SAGA, OTHER]);
  dbMocks.getFriendByLineUserId.mockImplementation(async () => friend());
  dbMocks.getFriendByLineUserIdForAccount.mockImplementation(async () => friend());
  dbMocks.upsertFriend.mockImplementation(async () => friend());
  dbMocks.getLineAccountByChannelId.mockResolvedValue(null);
  dbMocks.getScenarios.mockResolvedValue([]);
  dbMocks.getEntryRouteByRefCode.mockResolvedValue({ id: 'collision', tag_id: 'tag-1', scenario_id: 'scenario-1', run_account_friend_add_scenarios: 0 });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth2/v2.1/token')) {
      return Response.json({ access_token: 'fixture', id_token: 'fixture' });
    }
    if (url.endsWith('/oauth2/v2.1/verify')) {
      const channel = new URLSearchParams(String(init?.body)).get('client_id');
      return channel === verifiedLogin
        ? Response.json({ sub: 'line-user-1', name: 'fixture' })
        : new Response('', { status: 400 });
    }
    return new Response('', { status: 404 });
  }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

describe('Saga ref attribution before all provenance writes', () => {
  it.each(['user-1', null])('records first touch and tracking without a campaign for user_id=%s', async (userId) => {
    sqlite.prepare('UPDATE friends SET user_id = ?').run(userId);
    const res = await call('/api/liff/link', { idToken: 'fixture', ref: REF });
    expect(res.status).toBe(200);
    expect(friend()).toMatchObject({ ref_code: REF, last_ref_code: REF });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ref_tracking').get()).toEqual({ n: 1 });
    expect(dbMocks.getEntryRouteByRefCode).not.toHaveBeenCalled();
    assertNoCampaign();
  });

  it.each([
    ['other-login', 'account-other', REF], ['other-login', 'account-saga', REF],
    ['saga-login', 'account-other', REF], ['default-login', 'account-saga', REF],
    ['saga-login', 'account-saga', 'Sagarifuji-Threads'],
  ])('rejects dedicated provenance with verified=%s friend=%s ref=%s', async (login, accountId, ref) => {
    verifiedLogin = login;
    sqlite.prepare('UPDATE friends SET line_account_id = ?').run(accountId);
    const res = await call('/api/liff/link', { idToken: 'fixture', ref, account: '2011217182' });
    expect(res.status).toBe(200);
    expect(friend()).toMatchObject({ ref_code: null, last_ref_code: null, last_ref_at: null });
    expect(dbMocks.recordRefTracking).not.toHaveBeenCalled();
    assertNoCampaign();
  });

  it('preserves an existing first ref and counts repeated visits as one friend', async () => {
    sqlite.prepare("UPDATE friends SET ref_code = 'earlier-ref'").run();
    await call('/api/liff/link', { idToken: 'fixture', ref: REF });
    await call('/api/liff/link', { idToken: 'fixture', ref: REF });
    expect(friend()).toMatchObject({ ref_code: 'earlier-ref', last_ref_code: REF });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM friends').get()).toEqual({ n: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ref_tracking').get()).toEqual({ n: 2 });
    assertNoCampaign();
  });

  it('does not trust an OAuth state account when verification used another account', async () => {
    verifiedLogin = 'default-login';
    dbMocks.getLineAccounts.mockResolvedValue([SAGA, { ...OTHER, login_channel_id: verifiedLogin }]);
    const state = btoa(JSON.stringify({ ref: REF, account: '2011217182' }));
    const res = await call(`/auth/callback?code=fixture&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(friend()).toMatchObject({ ref_code: null, last_ref_code: null });
    expect(dbMocks.recordRefTracking).not.toHaveBeenCalled();
    assertNoCampaign();
  });

  it('accepts OAuth provenance only for the verified channel and current friend account', async () => {
    dbMocks.getLineAccountByChannelId.mockResolvedValue({ ...SAGA, login_channel_secret: 'fixture' });
    const state = btoa(JSON.stringify({ ref: REF, account: '2011217182' }));
    const res = await call(`/auth/callback?code=fixture&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(friend()).toMatchObject({ ref_code: REF, last_ref_code: REF });
    expect(dbMocks.getEntryRouteByRefCode).not.toHaveBeenCalled();
    assertNoCampaign();
  });
});
