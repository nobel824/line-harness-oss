import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LineClient, Message } from '@line-crm/line-sdk';
import type { Friend } from '@line-crm/db';

const dbMocks = vi.hoisted(() => ({
  getLineAccountById: vi.fn(),
  getTemplateById: vi.fn(),
}));

const logOutgoingMessage = vi.hoisted(() => vi.fn());

vi.mock('@line-crm/db', () => ({
  getLineAccountById: dbMocks.getLineAccountById,
  getTemplateById: dbMocks.getTemplateById,
}));

vi.mock('./event-bus.js', () => ({ logOutgoingMessage }));

vi.mock('./step-delivery.js', () => ({
  resolveMetadata: vi.fn().mockResolvedValue({}),
  expandVariables: vi.fn((content: string) => content),
  buildMessage: vi.fn((messageType: string, content: string) => {
    if (messageType === 'flex') {
      return { type: 'flex', altText: 'あなたのHarnessマイル', contents: JSON.parse(content) };
    }
    return { type: 'text', text: content };
  }),
  messageToLogPayload: vi.fn((message: Message) => message.type === 'flex'
    ? { messageType: 'flex', content: JSON.stringify(message.contents) }
    : { messageType: 'text', content: 'text' }),
}));

import { matchAndReply } from './auto-reply.js';

const friend: Friend = {
  id: 'friend-1',
  line_user_id: 'U123',
  display_name: 'テストユーザー',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: 'user-1',
  line_account_id: 'account-1',
  metadata: '{}',
  first_tracked_link_id: null,
  created_at: '2026-08-11T10:00:00+09:00',
  updated_at: '2026-08-11T10:00:00+09:00',
};

const mileageFlex = JSON.stringify({
  type: 'bubble',
  footer: {
    type: 'box',
    layout: 'vertical',
    contents: [{
      type: 'button',
      action: {
        type: 'uri',
        label: 'マイルを確認する',
        uri: 'https://liff.line.me/{{liff_id}}/?page=affiliate&liffId={{liff_id}}',
      },
    }],
  },
});

function mileageRule(over: Record<string, unknown> = {}) {
  return {
    id: 'builtin-mileage-wallet-keyword',
    keyword: 'マイル',
    match_type: 'exact',
    response_type: 'flex',
    response_content: mileageFlex,
    template_id: null,
    line_account_id: null,
    is_active: 1,
    created_at: '2026-08-11T10:00:00+09:00',
    ...over,
  };
}

function fakeDb(rule: Record<string, unknown> = mileageRule()) {
  const statement = {
    bind: vi.fn(),
    all: vi.fn().mockResolvedValue({
      results: [rule],
    }),
  };
  statement.bind.mockReturnValue(statement);
  return { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database;
}

async function replyTo(
  incomingText: string,
  rule: Record<string, unknown>,
  opts: { accountId?: string | null; liffUrl?: string } = {},
) {
  const accountId = opts.accountId === undefined ? 'account-1' : opts.accountId;
  const proxyReply = vi.fn().mockResolvedValue(undefined);
  const result = await matchAndReply(
    fakeDb(rule),
    { replyMessage: vi.fn() } as unknown as LineClient,
    { ...friend, line_account_id: accountId },
    incomingText,
    'reply-token',
    {
      lineAccountId: accountId,
      workerUrl: 'https://worker.example.com',
      liffUrl: opts.liffUrl ?? 'https://liff.line.me/default-id',
      replyMessage: proxyReply,
    },
  );
  return { result, proxyReply };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'account-1',
    is_active: 1,
    liff_id: '123456-AccountOne',
  });
});

describe('mileage keyword auto reply', () => {
  test.each([
    ['account-1', '111111-AccountOne'],
    ['account-2', '222222-AccountTwo'],
    ['account-3', '333333-AccountThree'],
    ['account-4', '444444-AccountFour'],
  ])('uses the LIFF ID for receiving %s', async (accountId, liffId) => {
    const db = fakeDb();
    const directReply = vi.fn();
    const proxyReply = vi.fn().mockResolvedValue(undefined);
    dbMocks.getLineAccountById.mockResolvedValue({
      id: accountId,
      is_active: 1,
      liff_id: liffId,
    });

    const result = await matchAndReply(
      db,
      { replyMessage: directReply } as unknown as LineClient,
      { ...friend, line_account_id: accountId },
      'マイル',
      'reply-token',
      {
        lineAccountId: accountId,
        workerUrl: 'https://worker.example.com',
        liffUrl: 'https://liff.line.me/default-id',
        replyMessage: proxyReply,
      },
    );

    expect(result).toEqual({ matched: true, replyTokenConsumed: true });
    expect(dbMocks.getLineAccountById).toHaveBeenCalledWith(db, accountId);
    expect(directReply).not.toHaveBeenCalled();
    expect(proxyReply).toHaveBeenCalledTimes(1);

    const sent = proxyReply.mock.calls[0][1][0] as Extract<Message, { type: 'flex' }>;
    const contents = sent.contents as {
      footer: { contents: Array<{ action: { uri: string } }> };
    };
    const button = contents.footer.contents[0];
    expect(button.action.uri).toBe(
      `https://liff.line.me/${liffId}/?page=affiliate&liffId=${liffId}`,
    );
    expect(JSON.stringify(sent)).not.toContain('{{liff_id}}');
    expect(proxyReply.mock.calls[0][1]).toHaveLength(1);
    expect(logOutgoingMessage).toHaveBeenCalledTimes(1);
    expect(logOutgoingMessage).toHaveBeenCalledWith(db, expect.objectContaining({
      friendId: 'friend-1',
      deliveryType: 'reply',
      source: 'auto_reply',
      lineAccountId: accountId,
    }));
  });

  test('falls back to the default LIFF URL when the env account is not DB-registered', async () => {
    const proxyReply = vi.fn().mockResolvedValue(undefined);

    const result = await matchAndReply(
      fakeDb(),
      { replyMessage: vi.fn() } as unknown as LineClient,
      { ...friend, line_account_id: null },
      'マイル',
      'reply-token',
      {
        lineAccountId: null,
        liffUrl: 'https://liff.line.me/999999-Default/?existing=1',
        replyMessage: proxyReply,
      },
    );

    expect(result.replyTokenConsumed).toBe(true);
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    const sent = proxyReply.mock.calls[0][1][0] as Extract<Message, { type: 'flex' }>;
    expect(JSON.stringify(sent)).toContain(
      'https://liff.line.me/999999-Default/?page=affiliate&liffId=999999-Default',
    );
  });

  test('does not send another account URL when the receiving account has no LIFF ID', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'account-without-liff',
      is_active: 1,
      liff_id: null,
    });
    const proxyReply = vi.fn().mockResolvedValue(undefined);

    const result = await matchAndReply(
      fakeDb(),
      { replyMessage: vi.fn() } as unknown as LineClient,
      { ...friend, line_account_id: 'account-without-liff' },
      'マイル',
      'reply-token',
      {
        lineAccountId: 'account-without-liff',
        liffUrl: 'https://liff.line.me/main-account-id',
        replyMessage: proxyReply,
      },
    );

    expect(result).toEqual({ matched: true, replyTokenConsumed: false });
    expect(proxyReply).not.toHaveBeenCalled();
  });
});

describe('auto_reply second bubble', () => {
  const textRule = {
    id: 'rule-reward',
    keyword: '特典',
    match_type: 'exact' as const,
    response_type: 'text',
    response_content: '1通目です',
    template_id: null,
    line_account_id: null,
    is_active: 1,
    created_at: '2026-08-11T10:00:00+09:00',
  };

  test.each([
    ['カラムなし (既存レコード相当)', {}],
    ['response_content_2 が NULL', { response_type_2: null, response_content_2: null }],
    ['response_content_2 が空文字', { response_type_2: null, response_content_2: '' }],
    ['response_content_2 が空白のみ', { response_type_2: null, response_content_2: '   ' }],
    ['response_content_2 が改行のみ', { response_type_2: null, response_content_2: '\n' }],
  ])('2通目が無いとき (%s) は従来どおり1通だけ送る', async (_label, over) => {
    const { result, proxyReply } = await replyTo('特典', { ...textRule, ...over });

    expect(result).toEqual({ matched: true, replyTokenConsumed: true });
    expect(proxyReply).toHaveBeenCalledTimes(1);
    expect(proxyReply.mock.calls[0][1]).toEqual([{ type: 'text', text: '1通目です' }]);
    expect(logOutgoingMessage).toHaveBeenCalledTimes(1);
    expect(logOutgoingMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      friendId: 'friend-1',
      messageType: 'text',
      deliveryType: 'reply',
      source: 'auto_reply',
    }));
  });

  test('2通目があるとき replyMessage に2要素の配列が渡り、ログも2件記録される', async () => {
    const { result, proxyReply } = await replyTo('特典', {
      ...textRule,
      response_type_2: 'text',
      response_content_2: '2通目です',
    });

    expect(result).toEqual({ matched: true, replyTokenConsumed: true });
    expect(proxyReply).toHaveBeenCalledTimes(1);
    expect(proxyReply.mock.calls[0][1]).toEqual([
      { type: 'text', text: '1通目です' },
      { type: 'text', text: '2通目です' },
    ]);
    expect(logOutgoingMessage).toHaveBeenCalledTimes(2);
    expect(logOutgoingMessage).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      source: 'auto_reply',
      deliveryType: 'reply',
      messageType: 'text',
    }));
    expect(logOutgoingMessage).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      source: 'auto_reply',
      deliveryType: 'reply',
      messageType: 'text',
    }));
  });

  test('response_type_2 が NULL のときは 1通目の response_type で 2通目を送る', async () => {
    const { proxyReply } = await replyTo('特典', {
      ...textRule,
      response_type_2: null,
      response_content_2: '2通目は型省略',
    });

    expect(proxyReply.mock.calls[0][1]).toEqual([
      { type: 'text', text: '1通目です' },
      { type: 'text', text: '2通目は型省略' },
    ]);
  });

  test('{{liff_id}} は2通目でも展開される', async () => {
    const secondFlex = JSON.stringify({
      type: 'bubble',
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{
          type: 'button',
          action: {
            type: 'uri',
            label: '視聴する',
            uri: 'https://liff.line.me/{{liff_id}}/?page=webinar',
          },
        }],
      },
    });
    const { proxyReply } = await replyTo('特典', {
      ...textRule,
      response_type_2: 'flex',
      response_content_2: secondFlex,
    });

    const messages = proxyReply.mock.calls[0][1] as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'text', text: '1通目です' });
    const sent = messages[1] as Extract<Message, { type: 'flex' }>;
    const contents = sent.contents as {
      footer: { contents: Array<{ action: { uri: string } }> };
    };
    expect(contents.footer.contents[0].action.uri).toBe(
      'https://liff.line.me/123456-AccountOne/?page=webinar',
    );
    expect(JSON.stringify(sent)).not.toContain('{{liff_id}}');
  });
});
