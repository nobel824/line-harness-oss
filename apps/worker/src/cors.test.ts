import { describe, it, expect, vi } from 'vitest';

// index.ts pulls these eagerly at module load; provide no-op stubs so the
// import graph resolves under Vitest (same pattern as not-found.test.ts).
vi.mock('@line-crm/db', () => ({
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getTrafficPoolBySlug: vi.fn(),
  getTrafficPoolById: vi.fn(),
  getRandomPoolAccount: vi.fn(),
  getPoolAccounts: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
}));

import worker, { type Env } from './index.js';

const ADMIN_ORIGIN = 'https://admin.example.pages.dev';

async function preflight(path: string, requestHeaders: string): Promise<Response> {
  const req = new Request(`https://worker.example.com${path}`, {
    method: 'OPTIONS',
    headers: {
      Origin: ADMIN_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': requestHeaders,
    },
  });
  return worker.fetch(req, { ADMIN_ORIGIN, DB: {} as D1Database } as Env['Bindings'], {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);
}

describe('CORS preflight — headers the admin SPA actually sends', () => {
  // 管理画面は Worker とは別オリジン (Pages) なので、admin が送る custom header が
  // allowHeaders に無いとブラウザが preflight 後の本リクエストごと止める。
  // 「作成に失敗しました」だけが出てサーバーにはログが残らない沈黙故障になる。
  it.each([
    ['content-type', 'Content-Type'],
    ['authorization', 'Authorization'],
    ['x-csrf-token', 'X-CSRF-Token'],
    // POST /api/broadcasts の二重作成防止 (broadcast-form.tsx) が送る。
    ['idempotency-key', 'Idempotency-Key'],
  ])('allows %s', async (requested, expected) => {
    const res = await preflight('/api/broadcasts', requested);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase());
    expect(allowed).toContain(expected.toLowerCase());
  });
});
