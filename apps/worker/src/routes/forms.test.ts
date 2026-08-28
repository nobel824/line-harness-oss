import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const dbMocks = vi.hoisted(() => ({
  getForms: vi.fn(),
  getFormsWithStats: vi.fn(),
  getFormById: vi.fn(),
  createForm: vi.fn(),
  updateForm: vi.fn(),
  deleteForm: vi.fn(),
  getFormSubmissions: vi.fn(),
  createFormSubmission: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getFriendByLineUserIdForAccount: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  getWebinarBySlug: vi.fn(),
  hasFriendSubmittedForm: vi.fn(),
  jstNow: vi.fn(),
  resolveDefaultLineAccount: vi.fn(),
  enrollFriendInScenario: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);

const authMock = vi.hoisted(() => ({
  verifyCallerLineUserId: vi.fn(),
}));
vi.mock('../services/liff-auth.js', () => authMock);

vi.mock('../services/friend-tag-attach.js', () => ({
  attachTagAndFireSideEffects: vi.fn(),
}));
vi.mock('../services/line-proxy-send.js', () => ({
  pushViaHarnessProxy: vi.fn(),
}));
vi.mock('../services/local-line-proxy.js', () => ({
  dispatchLineProxyLocally: vi.fn(),
}));
vi.mock('../services/activity-mileage.js', () => ({
  awardActivityMileage: vi.fn(),
}));

import { forms } from './forms.js';

const baseForm = {
  id: 'form-1',
  name: '相談フォーム',
  description: '説明',
  fields: '[]',
  on_submit_message_content: null,
  on_submit_webhook_fail_message: null,
  on_submit_webhook_url: null,
  on_submit_webhook_headers: null,
  is_active: 1,
};

function makeEnv() {
  const first = vi.fn().mockResolvedValue(null);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const bindings = {
    DB: { prepare } as unknown as D1Database,
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    WORKER_URL: 'https://worker.example.test',
  } as Env['Bindings'];
  return { bindings, first, prepare };
}

function app() {
  const a = new Hono<Env>();
  a.route('/', forms);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFormById.mockResolvedValue({ ...baseForm });
  dbMocks.getWebinarBySlug.mockResolvedValue(null);
  dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue(null);
  dbMocks.hasFriendSubmittedForm.mockResolvedValue(false);
  dbMocks.resolveDefaultLineAccount.mockResolvedValue(null);
  authMock.verifyCallerLineUserId.mockResolvedValue(null);
});

describe('GET /api/forms/:id public consultation submission state', () => {
  test('does not query submission state when the form is not a consultation form', async () => {
    const { bindings, first, prepare } = makeEnv();

    const response = await app().request('/api/forms/form-1', {}, bindings);
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.alreadySubmitted).toBe(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).not.toContain('form_submissions');
    expect(authMock.verifyCallerLineUserId).not.toHaveBeenCalled();
    expect(dbMocks.hasFriendSubmittedForm).not.toHaveBeenCalled();
  });

  test('falls back to false for an unauthenticated consultation form without rejecting the request', async () => {
    const { bindings, first } = makeEnv();
    first.mockResolvedValue({ slug: 'webinar-1' });

    const response = await app().request('/api/forms/form-1', {}, bindings);
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.consultationWebinarSlug).toBe('webinar-1');
    expect(body.data.alreadySubmitted).toBe(false);
    expect(authMock.verifyCallerLineUserId).toHaveBeenCalledWith(undefined, bindings);
    expect(dbMocks.getWebinarBySlug).not.toHaveBeenCalled();
    expect(dbMocks.getFriendByLineUserIdForAccount).not.toHaveBeenCalled();
    expect(dbMocks.hasFriendSubmittedForm).not.toHaveBeenCalled();
  });

  test('returns true for an authenticated friend who has submitted the consultation form', async () => {
    const { bindings, first } = makeEnv();
    first.mockResolvedValue({ slug: 'webinar-1' });
    authMock.verifyCallerLineUserId.mockResolvedValue('line-user-1');
    dbMocks.getWebinarBySlug.mockResolvedValue({ account_id: 'account-1' });
    dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue({ id: 'friend-1' });
    dbMocks.hasFriendSubmittedForm.mockResolvedValue(true);

    const response = await app().request('/api/forms/form-1', {
      headers: { Authorization: 'Bearer valid-token' },
    }, bindings);
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.alreadySubmitted).toBe(true);
    expect(dbMocks.getWebinarBySlug).toHaveBeenCalledWith(bindings.DB, 'webinar-1');
    expect(dbMocks.getFriendByLineUserIdForAccount).toHaveBeenCalledWith(
      bindings.DB,
      'line-user-1',
      'account-1',
    );
    expect(dbMocks.hasFriendSubmittedForm).toHaveBeenCalledWith(
      bindings.DB,
      'form-1',
      'friend-1',
    );
  });

  test('returns false for an authenticated friend who has not submitted the consultation form', async () => {
    const { bindings, first } = makeEnv();
    first.mockResolvedValue({ slug: 'webinar-1' });
    authMock.verifyCallerLineUserId.mockResolvedValue('line-user-1');
    dbMocks.getWebinarBySlug.mockResolvedValue({ account_id: 'account-1' });
    dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue({ id: 'friend-1' });
    dbMocks.hasFriendSubmittedForm.mockResolvedValue(false);

    const response = await app().request('/api/forms/form-1', {
      headers: { Authorization: 'Bearer valid-token' },
    }, bindings);
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.alreadySubmitted).toBe(false);
    expect(dbMocks.hasFriendSubmittedForm).toHaveBeenCalledWith(
      bindings.DB,
      'form-1',
      'friend-1',
    );
  });
});
