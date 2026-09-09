import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { adminAccess } from './admin-access.js';
import type { Env } from '../index.js';

const getActiveStaffByEmail = vi.hoisted(() => vi.fn());
const verifyCloudflareAccessJwt = vi.hoisted(() => vi.fn());

vi.mock('@line-crm/db', () => ({
  getStaffByApiKey: vi.fn(async () => null),
  getActiveStaffByEmail,
}));
vi.mock('../lib/cloudflare-access.js', () => ({ verifyCloudflareAccessJwt }));

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    TENANT_SCHEDULER: {} as Env['Bindings']['TENANT_SCHEDULER'],
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'env-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'line-channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
    ADMIN_ORIGIN: 'https://admin.example.test',
    ADMIN_PUBLIC_URL: 'https://admin.example.test/console',
    ADMIN_BROWSER_AUTH_MODE: 'access',
    ADMIN_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    ADMIN_ACCESS_AUD: 'access-audience',
    ...overrides,
  };
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', adminAccess);
  return instance;
}

function cookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = res.headers.get('Set-Cookie');
  return single ? [single] : [];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /admin/access', () => {
  test('exchanges a registered staff Access identity for the existing cookie session', async () => {
    verifyCloudflareAccessJwt.mockResolvedValue({ ok: true, email: 'owner@example.test' });
    getActiveStaffByEmail.mockResolvedValue({
      kind: 'found', staff: { id: 'staff-1', api_key: 'staff-api-key' },
    });

    const res = await app().request('/admin/access', {
      headers: { 'Cf-Access-Jwt-Assertion': 'signed-assertion' },
    }, env());

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://admin.example.test/console');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(cookies(res).join(';')).toContain('lh_admin_session=staff-api-key');
    expect(cookies(res).join(';')).toContain('HttpOnly');
    expect(getActiveStaffByEmail).toHaveBeenCalledWith(expect.anything(), 'owner@example.test');
  });

  test('uses ADMIN_ORIGIN when it is a different Pages origin', async () => {
    verifyCloudflareAccessJwt.mockResolvedValue({ ok: true, email: 'owner@example.test' });
    getActiveStaffByEmail.mockResolvedValue({
      kind: 'found', staff: { id: 'staff-1', api_key: 'staff-api-key' },
    });
    const res = await app().request('/admin/access', {
      headers: { 'Cf-Access-Jwt-Assertion': 'signed-assertion' },
    }, env({
      ADMIN_ORIGIN: 'https://legacy-admin.pages.dev',
      ADMIN_ALLOW_CROSS_SITE: 'true',
      ADMIN_PUBLIC_URL: 'https://tenant.example.test/console',
    }));
    expect(res.headers.get('Location')).toBe('https://legacy-admin.pages.dev');
  });

  test('keeps ADMIN_PUBLIC_URL basePath when it shares ADMIN_ORIGIN', async () => {
    verifyCloudflareAccessJwt.mockResolvedValue({ ok: true, email: 'owner@example.test' });
    getActiveStaffByEmail.mockResolvedValue({
      kind: 'found', staff: { id: 'staff-1', api_key: 'staff-api-key' },
    });
    const res = await app().request('/admin/access', {
      headers: { 'Cf-Access-Jwt-Assertion': 'signed-assertion' },
    }, env({
      ADMIN_ORIGIN: 'https://tenant.example.test',
      ADMIN_PUBLIC_URL: 'https://tenant.example.test/console/',
    }));
    expect(res.headers.get('Location')).toBe('https://tenant.example.test/console');
  });

  test('falls back to normalized ADMIN_PUBLIC_URL without an ADMIN_ORIGIN allowlist', async () => {
    verifyCloudflareAccessJwt.mockResolvedValue({ ok: true, email: 'owner@example.test' });
    getActiveStaffByEmail.mockResolvedValue({
      kind: 'found', staff: { id: 'staff-1', api_key: 'staff-api-key' },
    });
    const res = await app().request('/admin/access', {
      headers: { 'Cf-Access-Jwt-Assertion': 'signed-assertion' },
    }, env({
      ADMIN_ORIGIN: undefined,
      ADMIN_PUBLIC_URL: 'https://tenant.example.test/console/',
    }));
    expect(res.headers.get('Location')).toBe('https://tenant.example.test/console');
  });

  test.each([
    ['invalid assertion', { ok: false, reason: 'invalid_token' }],
    ['unknown email', { ok: true, email: 'unknown@example.test' }, { kind: 'not_found' }],
    ['duplicate email', { ok: true, email: 'dup@example.test' }, { kind: 'duplicate' }],
  ])('%s is rejected without cookies', async (_label, verification, staff = undefined) => {
    verifyCloudflareAccessJwt.mockResolvedValue(verification);
    if (staff) getActiveStaffByEmail.mockResolvedValue(staff);
    const res = await app().request('/admin/access', {
      headers: { 'Cf-Access-Jwt-Assertion': 'assertion' },
    }, env());
    expect(res.status).toBe(403);
    expect(cookies(res)).toEqual([]);
  });

  test('access-only mode with incomplete settings fails closed', async () => {
    const res = await app().request('/admin/access', {}, env({ ADMIN_ACCESS_AUD: undefined }));
    expect(res.status).toBe(503);
    expect(cookies(res)).toEqual([]);
  });

  test('api_key mode does not expose the Access entrypoint', async () => {
    const res = await app().request('/admin/access', {}, env({ ADMIN_BROWSER_AUTH_MODE: 'api_key' }));
    expect(res.status).toBe(404);
  });
});
