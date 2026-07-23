import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const storedBroadcast = {
  id: 'broadcast-1',
  title: 'Test broadcast',
  message_type: 'text',
  message_content: 'Hello',
  target_type: 'all',
  target_tag_id: null,
  status: 'draft',
  scheduled_at: null,
  sent_at: null,
  total_count: 0,
  success_count: 0,
  created_at: '2026-07-23T00:00:00.000',
  account_ids: null,
  dedup_priority: null,
  failed_account_ids: null,
  dedup_progress: null,
  batch_lock_at: null,
  segment_conditions: null as string | null,
  track_links: 1,
};

const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/broadcast.js', () => ({
  processBroadcastSend: vi.fn(),
  buildMessage: vi.fn(),
  processQueuedBroadcasts: vi.fn(),
}));
vi.mock('../services/dedup-broadcast.js', () => ({
  computeDedupBroadcastPreview: vi.fn(),
}));
vi.mock('../services/segment-send.js', () => ({
  processSegmentSend: vi.fn(),
}));

const { broadcasts } = await import('./broadcasts.js');

function makeDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    })),
  } as unknown as D1Database;
}

const env = {
  DB: makeDb(),
  LINE_CHANNEL_ACCESS_TOKEN: 'token',
  WORKER_URL: 'https://worker.example.com',
} as unknown as Record<string, unknown>;

beforeEach(() => {
  storedBroadcast.segment_conditions = null;
  dbMocks.getBroadcastById.mockReset();
  dbMocks.updateBroadcast.mockReset();
  dbMocks.getBroadcastById.mockImplementation(async () => ({ ...storedBroadcast }));
  dbMocks.updateBroadcast.mockImplementation(async (_db: D1Database, _id: string, updates: Record<string, unknown>) => {
    if (updates.segment_conditions !== undefined) {
      storedBroadcast.segment_conditions = updates.segment_conditions as string | null;
    }
    return { ...storedBroadcast };
  });
});

describe('broadcast segment condition write path', () => {
  it('persists segmentConditions through PUT and returns it from GET serialization', async () => {
    const app = new Hono();
    app.route('/', broadcasts);
    const conditions = JSON.stringify({
      operator: 'AND',
      rules: [{ type: 'tag_not_exists', value: 'exclude-tag' }],
    });

    const put = await app.request('/api/broadcasts/broadcast-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segmentConditions: conditions }),
    }, env);

    expect(put.status).toBe(200);
    expect(dbMocks.updateBroadcast).toHaveBeenCalledWith(
      env.DB,
      'broadcast-1',
      expect.objectContaining({ segment_conditions: conditions }),
    );
    const putBody = (await put.json()) as { data: { segmentConditions: string } };
    expect(putBody.data.segmentConditions).toBe(conditions);

    const get = await app.request('/api/broadcasts/broadcast-1', {}, env);
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { data: { segmentConditions: string } };
    expect(getBody.data.segmentConditions).toBe(conditions);
  });
});
