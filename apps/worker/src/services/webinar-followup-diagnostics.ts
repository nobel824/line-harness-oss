import {
  getWebinarFollowupConfig,
  jstNow,
  type WebinarFollowupConfig,
} from '@line-crm/db';
import {
  candidates,
  journeyCandidates,
  type WebinarFollowupKind,
  type WebinarJourneyFollowupKind,
} from './webinar-followups.js';

export const WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES = [
  'after_30m',
  'after_24h',
  'picker_no_registration',
  'registered_no_show',
  'submitted_no_booking_30m',
  'submitted_no_booking_24h',
  'archive_closing',
] as const;

export type WebinarFollowupDiagnosticStage =
  typeof WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES[number];

export type WebinarFollowupDiagnosticVerdict =
  | 'blocked_by_config'
  | 'has_candidates'
  | 'undetermined'
  | 'no_population'
  | 'suppressed'
  | 'needs_investigation';

export type WebinarFollowupDiagnosticBlocker =
  | 'config_inactive'
  | 'booking_url_missing'
  | 'booking_menu_missing'
  | 'form_cta_missing';

export type WebinarFollowupDiagnosticRows = {
  sent: number;
  skipped: number;
  failed: number;
  pending: number;
  permanentlyBlocked: number;
};

export type WebinarFollowupDiagnosticStageResult = {
  candidates: number;
  candidatesTruncated: boolean;
  population: number;
  rows: WebinarFollowupDiagnosticRows;
  blockers: WebinarFollowupDiagnosticBlocker[];
  verdict: WebinarFollowupDiagnosticVerdict;
};

export type WebinarFollowupDiagnostics = {
  config: ReturnType<typeof serializeConfig>;
  stages: Partial<Record<WebinarFollowupDiagnosticStage, WebinarFollowupDiagnosticStageResult>>;
  registrationsBySession: Array<{
    sessionStartAt: number;
    friends: number;
    ended: boolean;
  }>;
};

export type WebinarFollowupDiagnosticsOptions = {
  stage?: WebinarFollowupDiagnosticStage;
  now?: string;
};

type PopulationCounts = Record<WebinarFollowupDiagnosticStage, number>;

type RowCount = {
  kind: string;
  status: string;
  count: number | string;
  permanently_blocked: number | string | null;
};

type RegistrationSessionRow = {
  session_start_at: number;
  friends: number | string;
  ended: number | string;
};

function serializeConfig(config: WebinarFollowupConfig | null) {
  if (!config) return null;
  return {
    webinarId: config.webinar_id,
    enabledAt: config.enabled_at,
    firstDelayMinutes: config.first_delay_minutes,
    secondDelayMinutes: config.second_delay_minutes,
    isActive: Boolean(config.is_active),
    stageEnabledAt: config.stage_enabled_at,
    pickerDelayMinutes: config.picker_delay_minutes,
    noShowDelayMinutes: config.no_show_delay_minutes,
    bookingDelayMinutes: config.booking_delay_minutes,
    bookingSecondDelayMinutes: config.booking_second_delay_minutes,
    bookingMenuId: config.booking_menu_id,
    bookingUrl: config.booking_url,
    adminNotifyLineUserId: config.admin_notify_line_user_id,
  };
}

export function isWebinarFollowupDiagnosticStage(
  value: string,
): value is WebinarFollowupDiagnosticStage {
  return (WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES as readonly string[]).includes(value);
}

function emptyRows(): WebinarFollowupDiagnosticRows {
  return {
    sent: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    permanentlyBlocked: 0,
  };
}

function isLegacyStage(stage: WebinarFollowupDiagnosticStage): stage is WebinarFollowupKind {
  return stage === 'after_30m' || stage === 'after_24h';
}

async function stageCandidates(
  db: D1Database,
  stage: WebinarFollowupDiagnosticStage,
  now: string,
) {
  if (isLegacyStage(stage)) return candidates(db, stage, now);
  return journeyCandidates(db, stage as WebinarJourneyFollowupKind, now);
}

async function getPopulationCounts(
  db: D1Database,
  webinarId: string,
  now: string,
): Promise<PopulationCounts> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(DISTINCT v.friend_id)
            FROM webinar_viewers v
            JOIN friends f ON f.id = v.friend_id AND f.is_following = 1
            JOIN webinar_followup_configs cfg ON cfg.webinar_id = v.webinar_id
           WHERE v.webinar_id = ?
             AND v.cta_clicked_at IS NOT NULL
             AND datetime(v.cta_clicked_at) >= datetime(
               COALESCE(cfg.stage_enabled_at, cfg.enabled_at)
             )) AS after_30m,
         (SELECT COUNT(DISTINCT v.friend_id)
            FROM webinar_viewers v
            JOIN friends f ON f.id = v.friend_id AND f.is_following = 1
            JOIN webinar_followup_configs cfg ON cfg.webinar_id = v.webinar_id
           WHERE v.webinar_id = ?
             AND v.cta_clicked_at IS NOT NULL
             AND datetime(v.cta_clicked_at) >= datetime(
               COALESCE(cfg.stage_enabled_at, cfg.enabled_at)
             )) AS after_24h,
         (SELECT COUNT(DISTINCT p.friend_id)
            FROM webinar_picker_opens p
            JOIN friends f ON f.id = p.friend_id AND f.is_following = 1
            JOIN webinar_followup_configs cfg ON cfg.webinar_id = p.webinar_id
           WHERE p.webinar_id = ?
             AND datetime(p.opened_at) >= datetime(
               COALESCE(cfg.stage_enabled_at, cfg.enabled_at)
             )) AS picker_no_registration,
         (SELECT COUNT(DISTINCT r.friend_id)
            FROM webinar_registrations r
            JOIN friends f ON f.id = r.friend_id AND f.is_following = 1
            JOIN webinars w ON w.id = r.webinar_id
            JOIN webinar_followup_configs cfg ON cfg.webinar_id = r.webinar_id
           WHERE r.webinar_id = ?
             AND datetime(r.created_at) >= datetime(
               COALESCE(cfg.stage_enabled_at, cfg.enabled_at)
             )
             AND r.session_start_at + w.duration_seconds <= unixepoch(?))
           AS registered_no_show,
         (SELECT COUNT(DISTINCT fs.friend_id)
            FROM form_submissions fs
            JOIN friends f ON f.id = fs.friend_id AND f.is_following = 1
            JOIN webinar_ctas wc
              ON wc.form_id = fs.form_id AND wc.webinar_id = ?
            JOIN webinar_followup_configs cfg ON cfg.webinar_id = wc.webinar_id
           WHERE fs.friend_id IS NOT NULL
             AND datetime(fs.created_at) >= datetime(
               COALESCE(cfg.stage_enabled_at, cfg.enabled_at)
             )) AS submitted_no_booking_30m,
         (SELECT COUNT(DISTINCT fs.friend_id)
            FROM form_submissions fs
            JOIN friends f ON f.id = fs.friend_id AND f.is_following = 1
            JOIN webinar_ctas wc
              ON wc.form_id = fs.form_id AND wc.webinar_id = ?
            JOIN webinar_followup_configs cfg ON cfg.webinar_id = wc.webinar_id
           WHERE fs.friend_id IS NOT NULL
             AND datetime(fs.created_at) >= datetime(
               COALESCE(cfg.stage_enabled_at, cfg.enabled_at)
             )) AS submitted_no_booking_24h,
         (SELECT COUNT(DISTINCT r.friend_id)
            FROM webinar_registrations r
            JOIN friends f ON f.id = r.friend_id AND f.is_following = 1
            JOIN webinars w ON w.id = r.webinar_id
            JOIN webinar_followup_configs cfg ON cfg.webinar_id = r.webinar_id
           WHERE r.webinar_id = ?
             AND datetime(r.created_at) >= datetime(
               COALESCE(cfg.stage_enabled_at, cfg.enabled_at)
             )
             AND r.session_start_at + w.duration_seconds <= unixepoch(?))
           AS archive_closing`,
    )
    .bind(
      webinarId,
      webinarId,
      webinarId,
      webinarId,
      now,
      webinarId,
      webinarId,
      webinarId,
      now,
    )
    .first<Partial<PopulationCounts>>();

  return Object.fromEntries(
    WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES.map((stage) => [stage, Number(row?.[stage] ?? 0)]),
  ) as PopulationCounts;
}

async function getRowCounts(
  db: D1Database,
  webinarId: string,
  now: string,
): Promise<Map<string, WebinarFollowupDiagnosticRows>> {
  const [legacy, journey] = await Promise.all([
    db
      .prepare(
        `SELECT kind, status, COUNT(*) AS count,
                SUM(CASE WHEN status IN ('failed', 'pending')
                         AND datetime(created_at, '+24 hours') < datetime(?)
                         THEN 1 ELSE 0 END) AS permanently_blocked
           FROM webinar_followups
          WHERE webinar_id = ?
          GROUP BY kind, status`,
      )
      .bind(now, webinarId)
      .all<RowCount>(),
    db
      .prepare(
        `SELECT kind, status, COUNT(*) AS count,
                SUM(CASE WHEN status IN ('failed', 'pending')
                         AND datetime(created_at, '+24 hours') < datetime(?)
                         THEN 1 ELSE 0 END) AS permanently_blocked
           FROM webinar_journey_followups
          WHERE webinar_id = ?
          GROUP BY kind, status`,
      )
      .bind(now, webinarId)
      .all<RowCount>(),
  ]);

  const byKind = new Map<string, WebinarFollowupDiagnosticRows>();
  for (const row of [...(legacy.results ?? []), ...(journey.results ?? [])]) {
    const counts = byKind.get(row.kind) ?? emptyRows();
    if (row.status === 'sent' || row.status === 'skipped' || row.status === 'failed' || row.status === 'pending') {
      counts[row.status] += Number(row.count);
    }
    counts.permanentlyBlocked += Number(row.permanently_blocked ?? 0);
    byKind.set(row.kind, counts);
  }
  return byKind;
}

async function hasFormCta(db: D1Database, webinarId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present
         FROM webinar_ctas
        WHERE webinar_id = ? AND kind = 'form' AND form_id IS NOT NULL
        LIMIT 1`,
    )
    .bind(webinarId)
    .first<{ present: number }>();
  return row?.present === 1;
}

async function getRegistrationsBySession(
  db: D1Database,
  webinarId: string,
  now: string,
) {
  const { results } = await db
    .prepare(
      `SELECT r.session_start_at,
              COUNT(DISTINCT r.friend_id) AS friends,
              CASE WHEN r.session_start_at + w.duration_seconds <= unixepoch(?)
                   THEN 1 ELSE 0 END AS ended
         FROM webinar_registrations r
         JOIN webinars w ON w.id = r.webinar_id
         JOIN webinar_followup_configs cfg ON cfg.webinar_id = r.webinar_id
        WHERE r.webinar_id = ?
          AND datetime(r.created_at) >= datetime(
            COALESCE(cfg.stage_enabled_at, cfg.enabled_at)
          )
        GROUP BY r.session_start_at
        ORDER BY r.session_start_at ASC`,
    )
    .bind(now, webinarId)
    .all<RegistrationSessionRow>();
  return (results ?? []).map((row) => ({
    sessionStartAt: Number(row.session_start_at),
    friends: Number(row.friends),
    ended: Number(row.ended) === 1,
  }));
}

function blockersForStage(
  stage: WebinarFollowupDiagnosticStage,
  config: WebinarFollowupConfig | null,
  formCtaExists: boolean,
): WebinarFollowupDiagnosticBlocker[] {
  const blockers: WebinarFollowupDiagnosticBlocker[] = [];
  if (!config || config.is_active !== 1) blockers.push('config_inactive');
  if ((stage === 'after_30m' || stage === 'after_24h') && !formCtaExists) {
    blockers.push('form_cta_missing');
  }
  if (stage === 'submitted_no_booking_30m' || stage === 'submitted_no_booking_24h') {
    if (config?.booking_url === null) blockers.push('booking_url_missing');
    if (config?.booking_menu_id === null) blockers.push('booking_menu_missing');
  }
  return blockers;
}

function verdictForStage(
  candidates: number,
  candidatesTruncated: boolean,
  population: number,
  rows: WebinarFollowupDiagnosticRows,
  blockers: WebinarFollowupDiagnosticBlocker[],
): WebinarFollowupDiagnosticVerdict {
  if (blockers.length > 0) return 'blocked_by_config';
  // 候補が立っている＝次の tick で送られる。needs_investigation は「0通なのに
  // 説明がつかない」を指す唯一の警報なので、送信待ちを巻き込むと空振りする。
  if (candidates > 0) return 'has_candidates';
  // 全ウェビナー横断の LIMIT 50 に達した場合、このウェビナーの候補が
  // 50件の外にある可能性を排除できない。正常・異常のどちらにも丸めない。
  if (candidatesTruncated) return 'undetermined';
  if (rows.sent + rows.skipped + rows.permanentlyBlocked > 0) return 'suppressed';
  if (population === 0) return 'no_population';
  return 'needs_investigation';
}

export async function getWebinarFollowupDiagnostics(
  db: D1Database,
  webinarId: string,
  options: WebinarFollowupDiagnosticsOptions = {},
): Promise<WebinarFollowupDiagnostics> {
  const now = options.now ?? jstNow();
  const config = await getWebinarFollowupConfig(db, webinarId);
  const stages = options.stage ? [options.stage] : [...WEBINAR_FOLLOWUP_DIAGNOSTIC_STAGES];

  const [candidateResults, populationCounts, rowCounts, formCtaExists, registrationsBySession] =
    await Promise.all([
      Promise.all(
        stages.map(async (stage) => {
          const result = await stageCandidates(db, stage, now);
          const count = result.filter((candidate) => candidate.webinar_id === webinarId).length;
          return [stage, count, result.length >= 50] as const;
        }),
      ),
      getPopulationCounts(db, webinarId, now),
      getRowCounts(db, webinarId, now),
      hasFormCta(db, webinarId),
      getRegistrationsBySession(db, webinarId, now),
    ]);

  const candidateCounts = new Map(
    candidateResults.map(([stage, count]) => [stage, count]),
  );
  const candidateTruncated = new Map(
    candidateResults.map(([stage, , truncated]) => [stage, truncated]),
  );
  const diagnosticStages: Partial<
    Record<WebinarFollowupDiagnosticStage, WebinarFollowupDiagnosticStageResult>
  > = {};

  for (const stage of stages) {
    const population = populationCounts[stage] ?? 0;
    const rows = rowCounts.get(stage) ?? emptyRows();
    const blockers = blockersForStage(stage, config, formCtaExists);
    const candidates = candidateCounts.get(stage) ?? 0;
    diagnosticStages[stage] = {
      candidates,
      candidatesTruncated: candidateTruncated.get(stage) ?? false,
      population,
      rows,
      blockers,
      verdict: verdictForStage(
        candidates,
        candidateTruncated.get(stage) ?? false,
        population,
        rows,
        blockers,
      ),
    };
  }

  return {
    config: serializeConfig(config),
    stages: diagnosticStages,
    registrationsBySession,
  };
}
