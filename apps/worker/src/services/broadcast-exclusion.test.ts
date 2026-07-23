import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { LineClient } from '@line-crm/line-sdk';

const dbMocks = vi.hoisted(() => ({
  getBroadcastById: vi.fn(),
  getBroadcasts: vi.fn(),
  getQueuedBroadcasts: vi.fn(),
  updateBroadcastStatus: vi.fn(),
  updateBroadcastBatchProgress: vi.fn(),
  getFriendsByTag: vi.fn(),
  jstNow: vi.fn(() => '2026-07-23T12:00:00'),
  updateBroadcastLineRequestId: vi.fn(),
  createBroadcastInsight: vi.fn(),
  getLineAccountById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);

const dedupMocks = vi.hoisted(() => ({
  computeDedupBroadcastPreview: vi.fn(),
  processMultiAccountDedupBroadcast: vi.fn(),
}));

vi.mock('./dedup-broadcast.js', () => dedupMocks);

import { processBroadcastSend, processQueuedBroadcasts, processScheduledBroadcasts } from './broadcast.js';
import { broadcasts } from '../routes/broadcasts.js';

interface FriendRow {
  id: string;
  line_user_id: string;
  is_following: number;
  tagIds: string[];
}

interface BroadcastRow {
  id: string;
  title: string;
  message_type: 'text';
  message_content: string;
  target_type: 'all' | 'tag' | 'multi-account-dedup';
  target_tag_id: string | null;
  status: 'draft' | 'scheduled' | 'sending' | 'sent';
  scheduled_at: string | null;
  sent_at: string | null;
  total_count: number;
  success_count: number;
  batch_offset: number;
  segment_conditions: string | null;
  account_ids: string | null;
  dedup_priority: string | null;
  track_links: number;
  [key: string]: unknown;
}

interface FakeDbState {
  friends: FriendRow[];
  broadcasts: Map<string, BroadcastRow>;
}

class D1Stmt {
  constructor(private readonly state: FakeDbState, private readonly sql: string, private readonly params: unknown[] = []) {}

  bind(...params: unknown[]) {
    return new D1Stmt(this.state, this.sql, params);
  }

  async first<T>() {
    if (this.sql.includes('SELECT * FROM broadcasts WHERE id = ?')) {
      return (this.state.broadcasts.get(String(this.params[0])) as T | undefined) ?? null;
    }
    if (this.sql.includes('COUNT(*) AS cnt')) {
      return { cnt: this.matchingFriends().length } as T;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes('SELECT * FROM broadcasts')) {
      return { results: [...this.state.broadcasts.values()] as T[], success: true, meta: {} };
    }
    if (this.sql.startsWith('SELECT f.id, f.line_user_id FROM friends f')) {
      return { results: this.matchingFriends() as T[], success: true, meta: {} };
    }
    return {
      results: [] as T[],
      success: true,
      meta: {},
    };
  }

  async run() {
    let changes = 0;
    const id = this.sql.includes('batch_offset = -1')
      ? String(this.params[0])
      : String(this.params[this.params.length - 1]);
    const broadcast = this.state.broadcasts.get(id);

    if (broadcast && this.sql.includes('WHERE id = ?')) {
      if (this.sql.includes("status = 'draft'")) {
        if (broadcast.status === 'draft') {
          broadcast.status = 'sending';
          changes = 1;
        }
      } else if (this.sql.includes("status = 'scheduled'")) {
        if (broadcast.status === 'scheduled') {
          broadcast.status = 'sending';
          changes = 1;
        }
      } else if (this.sql.includes('batch_offset = -1')) {
        const expectedOffset = Number(this.params[1]);
        if (broadcast.batch_offset === expectedOffset) {
          broadcast.batch_offset = -1;
          changes = 1;
        }
      } else if (this.sql.includes('target_tag_id = ?')) {
        broadcast.target_tag_id = String(this.params[0]);
        changes = 1;
      } else if (this.sql.includes('status = ?')) {
        broadcast.status = String(this.params[0]) as BroadcastRow['status'];
        changes = 1;
      } else if (this.sql.includes('total_count = ?')) {
        broadcast.total_count = Number(this.params[0]);
        changes = 1;
      } else if (this.sql.includes('success_count = success_count + ?')) {
        broadcast.success_count += Number(this.params[0]);
        changes = 1;
      } else if (this.sql.includes("status = 'sent'")) {
        broadcast.status = 'sent';
        broadcast.sent_at = '2026-07-23T12:00:00';
        changes = 1;
      }
    }

    return { success: true, meta: { changes, last_row_id: 0 } };
  }

  private matchingFriends() {
    const hasNotExists = this.sql.includes('NOT EXISTS');
    const excludedTag = hasNotExists ? String(this.params[this.params.length - 1]) : null;
    return this.state.friends
      .filter((friend) => friend.is_following === 1)
      .filter((friend) => !excludedTag || !friend.tagIds.includes(excludedTag))
      .map(({ id, line_user_id }) => ({ id, line_user_id }));
  }
}

function asD1(state: FakeDbState): D1Database {
  return {
    prepare: (sql: string) => new D1Stmt(state, sql),
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database;
}

function createDb() {
  const state: FakeDbState = { friends: [], broadcasts: new Map() };
  return { state, db: asD1(state) };
}

function seedBroadcast(state: FakeDbState, opts: {
  id: string;
  targetType?: 'all' | 'tag' | 'multi-account-dedup';
  status?: 'draft' | 'scheduled' | 'sending' | 'sent';
  segmentConditions?: string | null;
  scheduledAt?: string | null;
}) {
  state.broadcasts.set(opts.id, {
    id: opts.id,
    title: 'Test broadcast',
    message_type: 'text',
    message_content: 'hello',
    target_type: opts.targetType ?? 'all',
    target_tag_id: null,
    status: opts.status ?? 'draft',
    scheduled_at: opts.scheduledAt ?? null,
    sent_at: null,
    total_count: 0,
    success_count: 0,
    batch_offset: 0,
    segment_conditions: opts.segmentConditions ?? null,
    account_ids: null,
    dedup_priority: null,
    track_links: 1,
  });
}

function seedFriends(state: FakeDbState) {
  state.friends.push(
    { id: 'keep', line_user_id: 'U_keep', is_following: 1, tagIds: [] },
    { id: 'excluded', line_user_id: 'U_excluded', is_following: 1, tagIds: ['exclude-tag'] },
    { id: 'blocked', line_user_id: 'U_blocked', is_following: 0, tagIds: [] },
  );
}

function wireDbMocks() {
  dbMocks.getBroadcastById.mockImplementation(async (db: D1Database, id: string) =>
    db.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(id).first(),
  );
  dbMocks.getBroadcasts.mockImplementation(async (db: D1Database) =>
    (await db.prepare('SELECT * FROM broadcasts').all()).results,
  );
  dbMocks.getQueuedBroadcasts.mockImplementation(async (db: D1Database) =>
    (await db.prepare(
      `SELECT * FROM broadcasts WHERE status = 'sending' AND batch_offset >= 0 AND sent_at IS NULL AND (segment_conditions IS NOT NULL OR account_ids IS NOT NULL)`,
    ).all()).results,
  );
  dbMocks.updateBroadcastStatus.mockImplementation(async (db: D1Database, id: string, status: string, counts?: { totalCount?: number; successCount?: number }) => {
    const assignments = ['status = ?'];
    const bindings: unknown[] = [status];
    if (counts?.totalCount !== undefined) {
      assignments.push('total_count = ?');
      bindings.push(counts.totalCount);
    }
    if (counts?.successCount !== undefined) {
      assignments.push('success_count = ?');
      bindings.push(counts.successCount);
    }
    if (status === 'sent') assignments.push("sent_at = '2026-07-23T12:00:00'");
    bindings.push(id);
    await db.prepare(`UPDATE broadcasts SET ${assignments.join(', ')} WHERE id = ?`).bind(...bindings).run();
  });
  dbMocks.getLineAccountById.mockResolvedValue(null);
}

function segmentConditions() {
  return JSON.stringify({
    operator: 'AND',
    rules: [{ type: 'tag_not_exists', value: 'exclude-tag' }],
  });
}

function lineClient() {
  return {
    broadcast: vi.fn().mockResolvedValue({ requestId: 'broadcast-request' }),
    multicast: vi.fn().mockResolvedValue({}),
  } as unknown as LineClient & {
    broadcast: ReturnType<typeof vi.fn>;
    multicast: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  wireDbMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('broadcast exclusion delivery', () => {
  it('manual /send skips inline broadcast and queued delivery excludes tagged and non-following friends', async () => {
    const { state, db } = createDb();
    seedFriends(state);
    seedBroadcast(state, { id: 'manual', segmentConditions: segmentConditions() });

    const response = await broadcasts.fetch(
      new Request('https://worker.test/api/broadcasts/manual/send', { method: 'POST' }),
      { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', WORKER_URL: '' } as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { segmentConditions: segmentConditions() },
    });
    expect(state.broadcasts.get('manual')).toMatchObject({
      status: 'sending',
      batch_offset: 0,
    });

    const client = lineClient();
    await processQueuedBroadcasts(db, client);

    expect(client.broadcast).not.toHaveBeenCalled();
    expect(client.multicast).toHaveBeenCalledTimes(1);
    expect(client.multicast.mock.calls[0][0]).toEqual(['U_keep']);
    expect(state.broadcasts.get('manual')).toMatchObject({
      total_count: 1,
      success_count: 1,
    });
  });

  it('scheduled all + segment follows the same queued exclusion path', async () => {
    const { state, db } = createDb();
    seedFriends(state);
    seedBroadcast(state, {
      id: 'scheduled',
      status: 'scheduled',
      scheduledAt: '2020-01-01T00:00:00.000Z',
      segmentConditions: segmentConditions(),
    });
    dbMocks.getBroadcasts.mockResolvedValue([state.broadcasts.get('scheduled')]);

    const client = lineClient();
    await processScheduledBroadcasts(db, client);

    expect(client.broadcast).not.toHaveBeenCalled();
    expect(state.broadcasts.get('scheduled')).toMatchObject({
      status: 'sending',
      batch_offset: 0,
    });

    await processQueuedBroadcasts(db, client);
    expect(client.multicast.mock.calls[0][0]).toEqual(['U_keep']);
  });

  it('preview-count returns the post-exclusion following-friend count', async () => {
    const { state, db } = createDb();
    seedFriends(state);
    seedBroadcast(state, { id: 'preview', segmentConditions: segmentConditions() });

    const response = await broadcasts.fetch(
      new Request('https://worker.test/api/broadcasts/preview/preview-count'),
      { DB: db } as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { count: 1 } });
  });

  it('keeps inline delivery for all without segment and for tag targets', async () => {
    const { state, db } = createDb();
    seedFriends(state);
    seedBroadcast(state, { id: 'all-no-segment' });
    const allClient = lineClient();
    await processBroadcastSend(db, allClient, 'all-no-segment');
    expect(allClient.broadcast).toHaveBeenCalledTimes(1);

    seedBroadcast(state, { id: 'tag-target', targetType: 'tag' });
    dbMocks.getFriendsByTag.mockResolvedValue([{ id: 'keep', line_user_id: 'U_keep', is_following: 1 }]);
    state.broadcasts.get('tag-target')!.target_tag_id = 'exclude-tag';
    const tagClient = lineClient();
    await processBroadcastSend(db, tagClient, 'tag-target');
    expect(tagClient.multicast).toHaveBeenCalledWith(['U_keep'], expect.any(Array), expect.any(Array));
  });

  it('preserves the existing multi-account-dedup queue handoff', async () => {
    const { state, db } = createDb();
    seedBroadcast(state, { id: 'dedup', targetType: 'multi-account-dedup' });
    dedupMocks.computeDedupBroadcastPreview.mockResolvedValue({ perAccount: [] });

    const client = lineClient();
    await processBroadcastSend(db, client, 'dedup');

    expect(client.broadcast).not.toHaveBeenCalled();
    expect(dedupMocks.computeDedupBroadcastPreview).toHaveBeenCalled();
    expect(state.broadcasts.get('dedup')).toMatchObject({
      status: 'sending',
      batch_offset: 0,
    });
  });
});
