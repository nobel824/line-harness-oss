import { beforeEach, describe, expect, test, vi } from 'vitest';

const candidateCounts = {
  after_30m: 0,
  after_24h: 0,
  picker_no_registration: 0,
  registered_no_show: 0,
  submitted_no_booking_30m: 0,
  submitted_no_booking_24h: 0,
  archive_closing: 0,
};

const dbMocks = vi.hoisted(() => ({
  getLineAccounts: vi.fn().mockResolvedValue([]),
  recoverStalledBroadcasts: vi.fn().mockResolvedValue(undefined),
  recoverStuckDeliveries: vi.fn().mockResolvedValue(undefined),
  enqueueFollowingMileageMilestones: vi.fn().mockResolvedValue({ eventsCreated: 0, queued: 0 }),
  processPendingMileageEvents: vi.fn().mockResolvedValue({
    claimed: 0, processed: 0, failed: 0, granted: 0,
  }),
  cleanupWebhookEventDedup: vi.fn().mockResolvedValue(0),
  toJstString: vi.fn((date: Date) => date.toISOString()),
  jstNow: vi.fn(() => '2026-08-30T20:00:00+09:00'),
}));
vi.mock('@line-crm/db', () => dbMocks);

const serviceMocks = vi.hoisted(() => ({
  processStepDeliveries: vi.fn().mockResolvedValue(undefined),
  processScheduledBroadcasts: vi.fn().mockResolvedValue(undefined),
  processQueuedBroadcasts: vi.fn().mockResolvedValue(undefined),
  startBulkSendJobs: vi.fn().mockReturnValue([]),
  processReminderDeliveries: vi.fn().mockResolvedValue(undefined),
  checkAccountHealth: vi.fn().mockResolvedValue(undefined),
  refreshLineAccessTokens: vi.fn().mockResolvedValue(undefined),
  processInsightFetch: vi.fn().mockResolvedValue(undefined),
  processDueReminders: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  runExpirer: vi.fn().mockResolvedValue({ expired: 0, idempotencyPurged: 0 }),
  processDueEventReminders: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  processDueMeetConsultationReminders: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  runEventBookingExpirer: vi.fn().mockResolvedValue({ expired: 0, idempotencyPurged: 0 }),
  logRetentionDays: vi.fn().mockReturnValue(0),
  sendEventBookingNotification: vi.fn(),
  sendBookingNotification: vi.fn(),
  processWebinarReminders: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  processWebinarFollowups: vi.fn().mockResolvedValue({
    sent: 0,
    failed: 0,
    candidates: {
      after_30m: 0,
      after_24h: 0,
      picker_no_registration: 0,
      registered_no_show: 0,
      submitted_no_booking_30m: 0,
      submitted_no_booking_24h: 0,
      archive_closing: 0,
    },
  }),
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(_accessToken: string) {}
  },
}));
vi.mock('./services/step-delivery.js', () => ({ processStepDeliveries: serviceMocks.processStepDeliveries }));
vi.mock('./services/broadcast.js', () => ({
  processScheduledBroadcasts: serviceMocks.processScheduledBroadcasts,
  processQueuedBroadcasts: serviceMocks.processQueuedBroadcasts,
}));
vi.mock('./services/quota.js', () => ({ startBulkSendJobs: serviceMocks.startBulkSendJobs }));
vi.mock('./services/reminder-delivery.js', () => ({ processReminderDeliveries: serviceMocks.processReminderDeliveries }));
vi.mock('./services/ban-monitor.js', () => ({ checkAccountHealth: serviceMocks.checkAccountHealth }));
vi.mock('./services/token-refresh.js', () => ({ refreshLineAccessTokens: serviceMocks.refreshLineAccessTokens }));
vi.mock('./services/insight-fetcher.js', () => ({ processInsightFetch: serviceMocks.processInsightFetch }));
vi.mock('./services/booking-reminders.js', () => ({
  processDueReminders: serviceMocks.processDueReminders,
}));
vi.mock('./services/booking-expirer.js', () => ({ runExpirer: serviceMocks.runExpirer }));
vi.mock('./services/event-booking-reminders.js', () => ({
  processDueEventReminders: serviceMocks.processDueEventReminders,
}));
vi.mock('./services/meet-consultation-reminders.js', () => ({
  processDueMeetConsultationReminders: serviceMocks.processDueMeetConsultationReminders,
}));
vi.mock('./services/event-booking-expirer.js', () => ({
  runEventBookingExpirer: serviceMocks.runEventBookingExpirer,
}));
vi.mock('./services/log-retention.js', () => ({ logRetentionDays: serviceMocks.logRetentionDays }));
vi.mock('./services/event-booking-notifier.js', () => ({
  sendEventBookingNotification: serviceMocks.sendEventBookingNotification,
}));
vi.mock('./services/booking-notifier.js', () => ({
  sendBookingNotification: serviceMocks.sendBookingNotification,
}));
vi.mock('./services/booking-types.js', () => ({
  DEFAULT_ACCOUNT_SETTINGS: { reminder_hours_before: 24 },
}));
vi.mock('./services/webinar-reminders.js', () => ({
  processWebinarReminders: serviceMocks.processWebinarReminders,
}));
vi.mock('./routes/line-proxy.js', () => ({
  lineProxy: { fetch: vi.fn() },
}));

const { scheduled } = await import('./scheduled.js');

const emptyDb = {
  prepare() {
    const statement = {
      bind() {
        return statement;
      },
      async all() {
        return { results: [] };
      },
      async first() {
        return null;
      },
    };
    return statement;
  },
};
const env = {
  DB: emptyDb,
  IMAGES: {},
  LINE_CHANNEL_ACCESS_TOKEN: 'token',
  LIFF_URL: 'https://liff.line.me/liff-1',
  WORKER_URL: 'https://worker.example.com',
  WORKER_PUBLIC_URL: 'https://worker.example.com',
} as never;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never;

describe('scheduled webinar follow-up logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.processWebinarFollowups.mockResolvedValue({
      sent: 0,
      failed: 0,
      candidates: candidateCounts,
    });
  });

  test('AC-1/AC-2: 0通でも7 kindの候補件数を含むログを1行出す', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await scheduled(
      { cron: '*/5 * * * *', scheduledTime: Date.parse('2026-08-30T11:00:00Z') } as ScheduledEvent,
      env,
      ctx,
    );

    const followupLogs = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('[webinar-followups]'));
    expect(followupLogs).toHaveLength(1);
    expect(followupLogs[0]).toContain('sent=0 failed=0');
    for (const kind of Object.keys(candidateCounts)) {
      expect(followupLogs[0]).toContain(`${kind}=0`);
    }
    log.mockRestore();
  });

  test('候補SQLが失敗した kind は 0 ではなく err と出す', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // registered_no_show の候補SQL (WITH missed AS ...) だけを落とす DB。
    const failingDb = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async all() {
            if (sql.includes('WITH missed AS')) throw new Error('candidate sql boom');
            return { results: [] };
          },
          async first() {
            return null;
          },
        };
        return statement;
      },
    };

    await scheduled(
      { cron: '*/5 * * * *', scheduledTime: Date.parse('2026-08-30T11:00:00Z') } as ScheduledEvent,
      { ...(env as Record<string, unknown>), DB: failingDb } as never,
      ctx,
    );

    const followupLogs = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('[webinar-followups]'));
    // 「候補0」と「クエリが落ちた」が同じ 0 で出ると、この機能が塞ごうとしている
    // 沈黙故障をログの中に作り直すことになる。
    expect(followupLogs[0]).toContain('registered_no_show=err');
    expect(followupLogs[0]).toContain('picker_no_registration=0');
    log.mockRestore();
    errorLog.mockRestore();
  });
});
