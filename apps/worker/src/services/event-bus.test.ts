import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from './event-bus.js';

interface CapturedInsert {
  sql: string;
  binds: unknown[];
}

function fakeDb(opts: {
  friend?: { line_user_id: string };
  capturedInserts: CapturedInsert[];
  tagAlreadyAssigned?: boolean;
  existingFriendScenario?: { id: string } | null;
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (sql.includes('INSERT INTO messages_log')) {
            opts.capturedInserts.push({ sql, binds: args });
          }
          return this;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] };
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM friends WHERE id')) {
            return (opts.friend ?? null) as T | null;
          }
          if (sql.includes('FROM friend_scenarios')) {
            return (opts.existingFriendScenario ?? null) as T | null;
          }
          return null;
        },
        async run(): Promise<{ success: true; meta: { changes: number } }> {
          if (sql.includes('INSERT OR IGNORE INTO friend_tags')) {
            return {
              success: true,
              meta: { changes: opts.tagAlreadyAssigned ? 0 : 1 },
            };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
}

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return {
    ...actual,
    getActiveOutgoingWebhooksByEvent: vi.fn().mockResolvedValue([]),
    applyScoring: vi.fn().mockResolvedValue(undefined),
    getActiveAutomationsByEvent: vi.fn(),
    createAutomationLog: vi.fn().mockResolvedValue(undefined),
    getActiveNotificationRulesByEvent: vi.fn().mockResolvedValue([]),
    createNotification: vi.fn().mockResolvedValue(undefined),
    removeTagFromFriend: vi.fn().mockResolvedValue(undefined),
    getScenarios: vi.fn().mockResolvedValue([]),
    enrollFriendInScenario: vi.fn().mockResolvedValue(undefined),
    enqueueMileageEvent: vi.fn().mockResolvedValue(undefined),
    jstNow: () => '2026-05-08T00:00:00.000+09:00',
    getFriendScore: vi.fn().mockResolvedValue(0),
    getTemplateById: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@line-crm/line-sdk', () => {
  return {
    LineClient: vi.fn().mockImplementation(() => ({
      replyMessage: vi.fn().mockResolvedValue(undefined),
      pushMessage: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('./ad-conversion.js', () => ({
  sendAdConversions: vi.fn().mockResolvedValue(undefined),
}));

const immediateStepMocks = vi.hoisted(() => ({
  pushImmediateFirstStep: vi.fn(),
}));

vi.mock('./immediate-first-step.js', () => immediateStepMocks);

describe('fireEvent — send_message action logging', () => {
  let captured: CapturedInsert[];

  beforeEach(async () => {
    captured = [];
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-1',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({ keyword: 'コスト比較' }),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: {
              messageType: 'flex',
              content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"hi"}]}}',
              altText: 'hi',
            },
          },
        ]),
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('logs flex outgoing message to messages_log when send_message fires via reply', async () => {
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'コスト比較', matched: true },
        replyToken: 'reply-token-xyz',
      },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    const insert = captured[0];
    expect(insert.sql).toContain('INSERT INTO messages_log');
    // bind order: id, friendId, messageType, content, deliveryType, source, lineAccountId, createdAt
    expect(insert.binds[1]).toBe('friend-1');
    expect(insert.binds[2]).toBe('flex');
    expect(insert.binds[4]).toBe('reply');
    expect(insert.binds[5]).toBe('automation');
    expect(insert.binds[6]).toBe('acc-1');
  });

  it('logs delivery_type=push when no replyToken provided', async () => {
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'コスト比較', matched: true },
      },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[4]).toBe('push');
  });

  it('logs even when text message (not flex) is sent', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-2',
        line_account_id: null,
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: { messageType: 'text', content: 'hello' },
          },
        ]),
      },
    ]);

    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      dbFake,
      'tag_added',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      null,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[2]).toBe('text');
    expect(captured[0].binds[3]).toBe('hello');
    expect(captured[0].binds[6]).toBe(null);
  });

  it('resolves params.template_id via templates table when set', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-tpl',
        line_account_id: null,
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: {
              template_id: 'tpl-1',
              // content / messageType を空にして template 経由 resolve を強制
            },
          },
        ]),
      },
    ]);
    (db.getTemplateById as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      id: 'tpl-1',
      name: 'test-tpl',
      category: 'general',
      message_type: 'flex',
      message_content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"from-template"}]}}',
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      dbFake,
      'manual_test',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      null,
    );

    expect(captured).toHaveLength(1);
    // log には template から取得した messageType / content が記録される
    expect(captured[0].binds[2]).toBe('flex');
    expect(String(captured[0].binds[3])).toContain('from-template');
  });
});

const ADD_TAG_AUTOMATION = {
  id: 'auto-add-tag',
  line_account_id: null,
  conditions: JSON.stringify({}),
  actions: JSON.stringify([
    { type: 'add_tag', params: { tagId: 'tag-1' } },
  ]),
};

const TAG_ADDED_SCENARIO = {
  id: 'scenario-1',
  name: 'Tag scenario',
  description: null,
  trigger_type: 'tag_added' as const,
  trigger_tag_id: 'tag-1',
  line_account_id: null,
  is_active: 1,
  delivery_mode: 'relative' as const,
  created_at: '2026-05-08T00:00:00.000+09:00',
  updated_at: '2026-05-08T00:00:00.000+09:00',
  step_count: 1,
};

const ENROLLMENT = {
  id: 'friend-scenario-1',
  friend_id: 'friend-1',
  scenario_id: 'scenario-1',
  current_step_order: -1,
  status: 'active' as const,
  started_at: '2026-05-08T00:00:00.000+09:00',
  next_delivery_at: '2026-05-08T00:00:00.000+09:00',
  updated_at: '2026-05-08T00:00:00.000+09:00',
};

async function configureAddTagAutomation(scenarios: unknown[]) {
  const db = await import('@line-crm/db');
  (db.getActiveAutomationsByEvent as unknown as {
    mockImplementation: (implementation: (_db: D1Database, eventType: string) => unknown) => void;
  }).mockImplementation(async (_db, eventType) => {
    return eventType === 'message_received' ? [ADD_TAG_AUTOMATION] : [];
  });
  (db.getScenarios as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue(scenarios);
  (db.enrollFriendInScenario as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue(ENROLLMENT);
  immediateStepMocks.pushImmediateFirstStep.mockResolvedValue(true);
}

async function fireAddTagAction(opts: {
  capturedInserts: CapturedInsert[];
  tagAlreadyAssigned?: boolean;
  existingFriendScenario?: { id: string } | null;
  lineAccessToken?: string;
}): Promise<D1Database> {
  const db = fakeDb(opts);
  await fireEvent(
    db,
    'message_received',
    { friendId: 'friend-1', eventData: {} },
    opts.lineAccessToken,
  );
  return db;
}

describe('fireEvent — add_tag scenario enrollment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC-1: enrolls a friend in an active tag_added scenario for the newly added tag', async () => {
    await configureAddTagAutomation([TAG_ADDED_SCENARIO]);
    const captured: CapturedInsert[] = [];

    const db = await fireAddTagAction({ capturedInserts: captured });

    const dbModule = await import('@line-crm/db');
    expect(dbModule.getScenarios).toHaveBeenCalledWith(db);
    expect(dbModule.enrollFriendInScenario).toHaveBeenCalledWith(db, 'friend-1', 'scenario-1');
  });

  it('AC-2: does not enroll when the friend already has the tag and INSERT OR IGNORE changes=0', async () => {
    await configureAddTagAutomation([TAG_ADDED_SCENARIO]);
    const captured: CapturedInsert[] = [];

    await fireAddTagAction({ capturedInserts: captured, tagAlreadyAssigned: true });

    const dbModule = await import('@line-crm/db');
    expect(dbModule.getScenarios).not.toHaveBeenCalled();
    expect(dbModule.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  it('AC-3: does not enroll again when the friend is already enrolled in the scenario', async () => {
    await configureAddTagAutomation([TAG_ADDED_SCENARIO]);
    const captured: CapturedInsert[] = [];

    await fireAddTagAction({
      capturedInserts: captured,
      existingFriendScenario: { id: 'friend-scenario-existing' },
    });

    const dbModule = await import('@line-crm/db');
    expect(dbModule.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  it('AC-4: does not enroll in an inactive tag_added scenario', async () => {
    await configureAddTagAutomation([{ ...TAG_ADDED_SCENARIO, is_active: 0 }]);
    const captured: CapturedInsert[] = [];

    await fireAddTagAction({ capturedInserts: captured });

    const dbModule = await import('@line-crm/db');
    expect(dbModule.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  it('AC-6: does not enroll in a tag_added scenario whose trigger_tag_id is a different tag', async () => {
    await configureAddTagAutomation([{ ...TAG_ADDED_SCENARIO, trigger_tag_id: 'tag-other' }]);
    const captured: CapturedInsert[] = [];

    await fireAddTagAction({ capturedInserts: captured });

    const dbModule = await import('@line-crm/db');
    expect(dbModule.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  it('AC-5: does not call pushImmediateFirstStep for add_tag enrollment', async () => {
    await configureAddTagAutomation([TAG_ADDED_SCENARIO]);
    const captured: CapturedInsert[] = [];

    await fireAddTagAction({ capturedInserts: captured });

    expect(immediateStepMocks.pushImmediateFirstStep).not.toHaveBeenCalled();
  });

  // AC-5 だけだと「token が無いから push しなかった」との区別がつかない。
  // 他経路 (tracked-link / LIFF) は token があるときだけ push を渡すため、
  // 同じ形に寄せる回帰は token 無しのテストを素通りする。
  it('AC-5b: does not call pushImmediateFirstStep even when the event carries a LINE access token', async () => {
    await configureAddTagAutomation([TAG_ADDED_SCENARIO]);
    const captured: CapturedInsert[] = [];

    await fireAddTagAction({ capturedInserts: captured, lineAccessToken: 'token-1' });

    const dbModule = await import('@line-crm/db');
    expect(dbModule.enrollFriendInScenario).toHaveBeenCalledWith(expect.anything(), 'friend-1', 'scenario-1');
    expect(immediateStepMocks.pushImmediateFirstStep).not.toHaveBeenCalled();
  });

  it('AC-7: does not enroll in a scenario whose trigger_type is not tag_added', async () => {
    await configureAddTagAutomation([{ ...TAG_ADDED_SCENARIO, trigger_type: 'friend_add' as const }]);
    const captured: CapturedInsert[] = [];

    await fireAddTagAction({ capturedInserts: captured });

    const dbModule = await import('@line-crm/db');
    expect(dbModule.enrollFriendInScenario).not.toHaveBeenCalled();
  });
});
