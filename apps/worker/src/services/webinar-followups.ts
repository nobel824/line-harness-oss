// ウェビナーの予約前から個別相談予約まで、途中離脱した人へ自動追客する。
// 対象ウェビナーは webinar_followup_configs で明示的に有効化し、enabled_at
// より前の過去リードを一斉送信しない。LINE送信は必ずHarnessプロキシ経由。

import { getFriendById, getLineAccountById, jstNow } from '@line-crm/db';
import { pushViaHarnessProxy, type HarnessProxyDispatch } from './line-proxy-send.js';
import { ARCHIVE_WINDOW_DAYS } from './webinar-schedule.js';

export type WebinarFollowupOptions = {
  proxyBaseUrl: string;
  defaultAccessToken: string;
  defaultLiffId: string | null;
  proxyDispatch?: HarnessProxyDispatch;
};

type FollowupKind = 'after_30m' | 'after_24h';
export type WebinarJourneyFollowupKind =
  | 'picker_no_registration'
  | 'registered_no_show'
  | 'submitted_no_booking_30m'
  | 'submitted_no_booking_24h';

type Candidate = {
  webinar_id: string;
  account_id: string | null;
  friend_id: string;
  slug: string;
  form_id: string;
  cta_clicked_at: string;
};

type FollowupRow = {
  id: string;
  retry_key: string;
  status: 'pending' | 'sent' | 'failed';
};

type JourneyCandidate = {
  webinar_id: string;
  account_id: string | null;
  friend_id: string;
  slug: string;
  title: string;
  booking_url: string | null;
  source_at: string;
  duration_seconds?: number | null;
  last_position_seconds?: number | null;
  form_cta_at_seconds?: number | null;
};

export type RegisteredNoShowWatch = {
  lastPositionSeconds: number | null;
  formCtaAtSeconds: number | null;
  durationSeconds: number;
};

type JourneyFollowupRow = {
  id: string;
  retry_key: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
};

function formUrl(liffId: string, formId: string): string {
  return (
    `https://liff.line.me/${liffId}/?page=form&id=${encodeURIComponent(formId)}` +
    `&liffId=${liffId}`
  );
}

function webinarPickerUrl(liffId: string, slug: string): string {
  return (
    `https://liff.line.me/${liffId}/?page=webinar&slug=${encodeURIComponent(slug)}` +
    `&liffId=${liffId}`
  );
}

function remainingWatchLine(durationSeconds: number, lastPositionSeconds: number): string {
  const remainingSeconds = Math.max(0, durationSeconds - lastPositionSeconds);
  if (remainingSeconds < 60) return '※残りはあと少しです。';
  return `※残りは約${Math.round(remainingSeconds / 60)}分です。`;
}

function buildRegisteredNoShowText(
  title: string,
  pickerUrl: string,
  watch?: RegisteredNoShowWatch,
): string | null {
  const lastPosition = watch?.lastPositionSeconds ?? null;
  const ctaAt = watch?.formCtaAtSeconds ?? null;
  if (lastPosition !== null && ctaAt !== null && lastPosition >= ctaAt) {
    return null;
  }
  if (lastPosition !== null && ctaAt !== null && lastPosition < ctaAt && watch) {
    return (
      `「${title}」の続きがまだ残っています。\n\n` +
      `いちばんお伝えしたいのは終盤です。\n` +
      `Xを仕事につなげるために、最後に何から手をつけるかの話をしています。\n\n` +
      `お送りした入場リンクから、配信のあと${ARCHIVE_WINDOW_DAYS}日間は続きをご覧いただけます。\n\n` +
      remainingWatchLine(watch.durationSeconds, lastPosition)
    );
  }
  return (
    `ご予約いただいた「${title}」の回にお会いできませんでした。\n\n` +
    `お送りした入場リンクから、配信のあと${ARCHIVE_WINDOW_DAYS}日間は見返せます。\n\n` +
    `同じ内容を、月・水・金・土・日の20時から開催しています。\n` +
    `都合のよい回に選び直せます👇\n${pickerUrl}\n\n` +
    `※約57分です。カメラ・マイクは使いません。`
  );
}

export function buildJourneyFollowupText(
  kind: WebinarJourneyFollowupKind,
  title: string,
  pickerUrl: string,
  bookingUrl: string | null,
  watch?: RegisteredNoShowWatch,
): string | null {
  switch (kind) {
    case 'picker_no_registration':
      return (
        `先ほど「${title}」のページを開いていただいたようですが、\n` +
        `参加する回が未選択のままでした。\n\n` +
        `月・水・金・土・日の20時から開催しています。\n` +
        `回を1つ選んでおくと、開始5分前に専用の入場リンクがLINEに届きます。\n\n` +
        `参加する回を選ぶ👇\n${pickerUrl}\n\n` +
        `※約57分です。カメラ・マイクは使いません。ご覧いただくだけで参加できます。`
      );
    case 'registered_no_show':
      return buildRegisteredNoShowText(title, pickerUrl, watch);
    case 'submitted_no_booking_30m':
      return (
        `無料相談のご入力ありがとうございます🙌\n\n` +
        `送信は完了しています。あとは日時をお選びいただくと予約が確定します👇\n` +
        `${bookingUrl ?? ''}\n\n` +
        `料金はかかりません。30分です。\n` +
        `実際にあなたのXアカウントを見ながら、いまどこが詰まっているのか、` +
        `次の30日で何から手をつけるといいのかを一緒に整理します。`
      );
    case 'submitted_no_booking_24h':
      return (
        `昨日ご入力いただいた無料相談は、日時の選択が未完了のままです。\n\n` +
        `こちらから空いている日時をお選びいただけます👇\n${bookingUrl ?? ''}\n\n` +
        `すでに別の方法で日程が決まっている場合や、今回は見送られる場合は、` +
        `このままで大丈夫です。ご案内はこれで最後です。`
      );
  }
}

function buildCtaFollowupText(kind: FollowupKind, url: string): string {
  return kind === 'after_30m'
    ? `動画をご覧いただきありがとうございます🙌\n\n` +
        `無料相談のお申し込みが、入力の途中で止まっているようです。` +
        `続きからそのまま進められます👇\n${url}\n\n` +
        `お聞きするのは3つです。\n` +
        `・XアカウントのURL\n` +
        `・いま何をやっていて、何を売っているか\n` +
        `・いま一番詰まっていると感じるところ\n\n` +
        `料金はかかりません。30分です。`
    : `昨日ご案内した無料相談は、入力の途中から再開できます。\n\n` +
        `お聞きするのは、XアカウントのURL・いま何を売っているか・` +
        `いま一番詰まっていると感じるところの3つです。\n` +
        `送信すると、そのまま空いている日時をお選びいただけます👇\n${url}\n\n` +
        `ご案内はこれで最後です。`;
}

async function candidates(
  db: D1Database,
  kind: FollowupKind,
  cutoff: string,
): Promise<Candidate[]> {
  const delayColumn = kind === 'after_30m' ? 'first_delay_minutes' : 'second_delay_minutes';
  const { results } = await db.prepare(
    `WITH clicks AS (
       SELECT v.webinar_id, v.friend_id, MIN(v.cta_clicked_at) AS cta_clicked_at
       FROM webinar_viewers v
       JOIN webinar_followup_configs click_cfg
         ON click_cfg.webinar_id = v.webinar_id AND click_cfg.is_active = 1
       WHERE v.cta_clicked_at IS NOT NULL
         AND datetime(v.cta_clicked_at) >= datetime(click_cfg.enabled_at)
       GROUP BY v.webinar_id, v.friend_id
     )
     SELECT w.id AS webinar_id, w.account_id, c.friend_id, w.slug,
            c.cta_clicked_at,
            (SELECT wc.form_id FROM webinar_ctas wc
             WHERE wc.webinar_id = w.id AND wc.form_id IS NOT NULL
             ORDER BY wc.at_seconds ASC LIMIT 1) AS form_id
     FROM clicks c
     JOIN webinars w ON w.id = c.webinar_id
     JOIN friends f ON f.id = c.friend_id AND f.is_following = 1
     JOIN webinar_followup_configs cfg ON cfg.webinar_id = w.id AND cfg.is_active = 1
     WHERE datetime(c.cta_clicked_at) >= datetime(cfg.enabled_at)
       AND datetime(c.cta_clicked_at, '+' || cfg.${delayColumn} || ' minutes') <= datetime(?)
       AND NOT EXISTS (
         SELECT 1 FROM form_submissions fs
         JOIN webinar_ctas wc ON wc.form_id = fs.form_id
         WHERE wc.webinar_id = w.id AND fs.friend_id = c.friend_id
           AND datetime(fs.created_at) >= datetime(c.cta_clicked_at)
       )
       AND NOT EXISTS (
         SELECT 1 FROM webinar_followups wf
         WHERE wf.webinar_id = w.id AND wf.friend_id = c.friend_id
           AND wf.kind = ? AND wf.status = 'sent'
       )
       AND EXISTS (
         SELECT 1 FROM webinar_ctas wc
         WHERE wc.webinar_id = w.id AND wc.form_id IS NOT NULL
       )
     ORDER BY datetime(c.cta_clicked_at) ASC
     LIMIT 50`,
  ).bind(cutoff, kind).all<Candidate>();
  return results ?? [];
}

async function getOrCreateFollowup(
  db: D1Database,
  candidate: Candidate,
  kind: FollowupKind,
): Promise<FollowupRow> {
  const existing = await db.prepare(
    `SELECT id, retry_key, status FROM webinar_followups
     WHERE webinar_id = ? AND friend_id = ? AND kind = ?`,
  ).bind(candidate.webinar_id, candidate.friend_id, kind).first<FollowupRow>();
  if (existing) return existing;
  const row: FollowupRow = {
    id: crypto.randomUUID(), retry_key: crypto.randomUUID(), status: 'pending',
  };
  const now = jstNow();
  await db.prepare(
    `INSERT OR IGNORE INTO webinar_followups
       (id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    row.id, candidate.webinar_id, candidate.friend_id, kind, row.retry_key, now, now,
  ).run();
  return (
    await db.prepare(
      `SELECT id, retry_key, status FROM webinar_followups
       WHERE webinar_id = ? AND friend_id = ? AND kind = ?`,
    ).bind(candidate.webinar_id, candidate.friend_id, kind).first<FollowupRow>()
  )!;
}

async function journeyCandidates(
  db: D1Database,
  kind: WebinarJourneyFollowupKind,
  cutoff: string,
): Promise<JourneyCandidate[]> {
  if (kind === 'picker_no_registration') {
    const { results } = await db.prepare(
      `SELECT w.id AS webinar_id, w.account_id, p.friend_id, w.slug, w.title,
              cfg.booking_url, p.opened_at AS source_at
       FROM webinar_picker_opens p
       JOIN webinars w ON w.id = p.webinar_id
       JOIN webinar_followup_configs cfg
         ON cfg.webinar_id = w.id AND cfg.is_active = 1
       WHERE datetime(p.opened_at) >= datetime(COALESCE(cfg.stage_enabled_at, cfg.enabled_at))
         AND datetime(p.opened_at, '+' || cfg.picker_delay_minutes || ' minutes') <= datetime(?)
         AND NOT EXISTS (
           SELECT 1 FROM webinar_registrations r
           WHERE r.webinar_id = p.webinar_id AND r.friend_id = p.friend_id
             AND datetime(r.created_at) >= datetime(p.opened_at)
         )
         AND NOT EXISTS (
           SELECT 1 FROM webinar_viewers v
           WHERE v.webinar_id = p.webinar_id AND v.friend_id = p.friend_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM webinar_journey_followups jf
           WHERE jf.webinar_id = p.webinar_id AND jf.friend_id = p.friend_id
             AND jf.kind = ?
         )
       ORDER BY datetime(p.opened_at) ASC
       LIMIT 50`,
    ).bind(cutoff, kind).all<JourneyCandidate>();
    return results ?? [];
  }

  if (kind === 'registered_no_show') {
    const { results } = await db.prepare(
      `WITH missed AS (
         SELECT r.webinar_id, r.friend_id, MAX(r.session_start_at) AS missed_session_at
         FROM webinar_registrations r
         JOIN webinar_followup_configs cfg
           ON cfg.webinar_id = r.webinar_id AND cfg.is_active = 1
         WHERE datetime(r.created_at) >= datetime(COALESCE(cfg.stage_enabled_at, cfg.enabled_at))
           AND r.session_start_at + (cfg.no_show_delay_minutes * 60) <= unixepoch(?)
           AND NOT EXISTS (
             SELECT 1 FROM webinar_registrations future
             WHERE future.webinar_id = r.webinar_id AND future.friend_id = r.friend_id
               AND future.session_start_at > unixepoch(?)
           )
           AND NOT EXISTS (
             SELECT 1 FROM webinar_viewers v
             WHERE v.webinar_id = r.webinar_id AND v.friend_id = r.friend_id
               AND v.session_start_at = r.session_start_at
               -- form CTA が無いウェビナーでは MIN() が NULL になり比較が NULL に
               -- 評価されるため、視聴済みの人まで候補に残って「お会いできません
               -- でした」が飛ぶ。COALESCE(0) で「見たら除外」の従来挙動に戻す。
               AND v.last_position_seconds >= COALESCE(
                 (
                   SELECT MIN(wc.at_seconds) FROM webinar_ctas wc
                   WHERE wc.webinar_id = r.webinar_id AND wc.kind = 'form'
                 ),
                 0
               )
           )
         GROUP BY r.webinar_id, r.friend_id
       )
       SELECT w.id AS webinar_id, w.account_id, m.friend_id, w.slug, w.title,
              w.duration_seconds, cfg.booking_url,
              datetime(m.missed_session_at, 'unixepoch') AS source_at,
              (
                SELECT v.last_position_seconds FROM webinar_viewers v
                WHERE v.webinar_id = m.webinar_id AND v.friend_id = m.friend_id
                  AND v.session_start_at = m.missed_session_at
              ) AS last_position_seconds,
              (
                SELECT MIN(wc.at_seconds) FROM webinar_ctas wc
                WHERE wc.webinar_id = m.webinar_id AND wc.kind = 'form'
              ) AS form_cta_at_seconds
       FROM missed m
       JOIN webinars w ON w.id = m.webinar_id
       JOIN webinar_followup_configs cfg
         ON cfg.webinar_id = w.id AND cfg.is_active = 1
       WHERE NOT EXISTS (
           SELECT 1 FROM form_submissions fs
           JOIN webinar_ctas wc ON wc.form_id = fs.form_id
           WHERE wc.webinar_id = m.webinar_id AND fs.friend_id = m.friend_id
             AND datetime(fs.created_at) >= datetime(COALESCE(cfg.stage_enabled_at, cfg.enabled_at))
         )
         AND NOT EXISTS (
           SELECT 1 FROM webinar_journey_followups jf
           WHERE jf.webinar_id = m.webinar_id AND jf.friend_id = m.friend_id
             AND jf.kind = ?
         )
       ORDER BY m.missed_session_at ASC
       LIMIT 50`,
    ).bind(cutoff, cutoff, kind).all<JourneyCandidate>();
    return results ?? [];
  }

  const delayColumn = kind === 'submitted_no_booking_30m'
    ? 'booking_delay_minutes'
    : 'booking_second_delay_minutes';
  const needsFirstFollowup = kind === 'submitted_no_booking_24h'
    ? `AND EXISTS (
         SELECT 1 FROM webinar_journey_followups first_jf
         WHERE first_jf.webinar_id = s.webinar_id AND first_jf.friend_id = s.friend_id
           AND first_jf.kind = 'submitted_no_booking_30m' AND first_jf.status = 'sent'
       )`
    : '';
  const { results } = await db.prepare(
    `WITH submissions AS (
       SELECT wc.webinar_id, fs.friend_id, MIN(fs.created_at) AS submitted_at
       FROM form_submissions fs
       JOIN webinar_ctas wc ON wc.form_id = fs.form_id
       JOIN webinar_followup_configs cfg
         ON cfg.webinar_id = wc.webinar_id AND cfg.is_active = 1
       WHERE fs.friend_id IS NOT NULL
         AND datetime(fs.created_at) >= datetime(COALESCE(cfg.stage_enabled_at, cfg.enabled_at))
       GROUP BY wc.webinar_id, fs.friend_id
     )
     SELECT w.id AS webinar_id, w.account_id, s.friend_id, w.slug, w.title,
            cfg.booking_url, s.submitted_at AS source_at
     FROM submissions s
     JOIN webinars w ON w.id = s.webinar_id
     JOIN webinar_followup_configs cfg
       ON cfg.webinar_id = w.id AND cfg.is_active = 1
     WHERE cfg.booking_menu_id IS NOT NULL AND cfg.booking_url IS NOT NULL
       AND datetime(s.submitted_at, '+' || cfg.${delayColumn} || ' minutes') <= datetime(?)
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.friend_id = s.friend_id AND b.menu_id = cfg.booking_menu_id
           AND b.status IN ('requested', 'confirmed', 'completed')
           AND datetime(b.created_at) >= datetime(s.submitted_at)
       )
       AND NOT EXISTS (
         SELECT 1 FROM meet_consultations mc
         WHERE mc.friend_id = s.friend_id AND mc.status IN ('confirmed', 'completed')
           AND datetime(mc.created_at) >= datetime(s.submitted_at)
       )
       AND NOT EXISTS (
         SELECT 1 FROM webinar_journey_followups jf
         WHERE jf.webinar_id = s.webinar_id AND jf.friend_id = s.friend_id
           AND jf.kind = ?
       )
       ${needsFirstFollowup}
     ORDER BY datetime(s.submitted_at) ASC
     LIMIT 50`,
  ).bind(cutoff, kind).all<JourneyCandidate>();
  return results ?? [];
}

async function getOrCreateJourneyFollowup(
  db: D1Database,
  candidate: JourneyCandidate,
  kind: WebinarJourneyFollowupKind,
): Promise<JourneyFollowupRow> {
  const existing = await db.prepare(
    `SELECT id, retry_key, status FROM webinar_journey_followups
     WHERE webinar_id = ? AND friend_id = ? AND kind = ?`,
  ).bind(candidate.webinar_id, candidate.friend_id, kind).first<JourneyFollowupRow>();
  if (existing) return existing;
  const now = jstNow();
  const row: JourneyFollowupRow = {
    id: crypto.randomUUID(),
    retry_key: crypto.randomUUID(),
    status: 'pending',
  };
  await db.prepare(
    `INSERT OR IGNORE INTO webinar_journey_followups
       (id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    row.id, candidate.webinar_id, candidate.friend_id, kind, row.retry_key, now, now,
  ).run();
  return (
    await db.prepare(
      `SELECT id, retry_key, status FROM webinar_journey_followups
       WHERE webinar_id = ? AND friend_id = ? AND kind = ?`,
    ).bind(candidate.webinar_id, candidate.friend_id, kind).first<JourneyFollowupRow>()
  )!;
}

async function deliveryConfig(
  db: D1Database,
  accountId: string | null,
  options: WebinarFollowupOptions,
): Promise<{ accessToken: string; liffId: string | null }> {
  if (accountId) {
    const account = await getLineAccountById(db, accountId);
    if (account) {
      return {
        accessToken: account.channel_access_token,
        liffId: account.liff_id ?? options.defaultLiffId,
      };
    }
  }
  return { accessToken: options.defaultAccessToken, liffId: options.defaultLiffId };
}

export async function processWebinarFollowups(
  db: D1Database,
  options: WebinarFollowupOptions,
): Promise<{ sent: number; failed: number }> {
  const now = jstNow();
  const due = [
    ...(await candidates(db, 'after_30m', now)).map((candidate) => ({ candidate, kind: 'after_30m' as const })),
    ...(await candidates(db, 'after_24h', now)).map((candidate) => ({ candidate, kind: 'after_24h' as const })),
  ];
  const journeyDue = [
    ...(await journeyCandidates(db, 'picker_no_registration', now)).map((candidate) => ({
      candidate, kind: 'picker_no_registration' as const,
    })),
    ...(await journeyCandidates(db, 'registered_no_show', now)).map((candidate) => ({
      candidate, kind: 'registered_no_show' as const,
    })),
    ...(await journeyCandidates(db, 'submitted_no_booking_30m', now)).map((candidate) => ({
      candidate, kind: 'submitted_no_booking_30m' as const,
    })),
    ...(await journeyCandidates(db, 'submitted_no_booking_24h', now)).map((candidate) => ({
      candidate, kind: 'submitted_no_booking_24h' as const,
    })),
  ];
  let sent = 0;
  let failed = 0;
  for (const { candidate, kind } of due) {
    const followup = await getOrCreateFollowup(db, candidate, kind);
    if (followup.status === 'sent') continue;
    try {
      const friend = await getFriendById(db, candidate.friend_id);
      if (!friend?.is_following) {
        // Candidate selection and delivery are separate operations. A friend can
        // block the account between them, so consume the row as a terminal
        // non-delivery instead of leaving it pending forever. If they follow
        // again later, candidates() can select this failed row for a retry.
        const skippedAt = jstNow();
        await db.prepare(
          `UPDATE webinar_followups
           SET status = 'failed', last_error = 'not_following', updated_at = ? WHERE id = ?`,
        ).bind(skippedAt, followup.id).run();
        continue;
      }
      const delivery = await deliveryConfig(db, candidate.account_id, options);
      if (!delivery.liffId) throw new Error('LIFF ID not configured');
      const url = formUrl(delivery.liffId, candidate.form_id);
      const text = buildCtaFollowupText(kind, url);
      await pushViaHarnessProxy(
        options.proxyBaseUrl,
        delivery.accessToken,
        friend.line_user_id,
        [{ type: 'text', text }],
        followup.retry_key,
        options.proxyDispatch,
      );
      await db.prepare(
        `UPDATE webinar_followups
         SET status = 'sent', sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      ).bind(jstNow(), jstNow(), followup.id).run();
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.prepare(
        `UPDATE webinar_followups
         SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      ).bind(message.slice(0, 500), jstNow(), followup.id).run();
      console.error('webinar followup error:', candidate.webinar_id, candidate.friend_id, kind, err);
      failed++;
    }
  }

  for (const { candidate, kind } of journeyDue) {
    const followup = await getOrCreateJourneyFollowup(db, candidate, kind);
    if (followup.status === 'sent' || followup.status === 'skipped') continue;
    try {
      const friend = await getFriendById(db, candidate.friend_id);
      if (!friend?.is_following) {
        await db.prepare(
          `UPDATE webinar_journey_followups
           SET status = 'skipped', last_error = 'not_following', updated_at = ? WHERE id = ?`,
        ).bind(jstNow(), followup.id).run();
        continue;
      }
      const delivery = await deliveryConfig(db, candidate.account_id, options);
      if (!delivery.liffId) throw new Error('LIFF ID not configured');
      const pickerUrl = webinarPickerUrl(delivery.liffId, candidate.slug);
      const text = buildJourneyFollowupText(
        kind,
        candidate.title,
        pickerUrl,
        candidate.booking_url,
        kind === 'registered_no_show'
          ? {
              lastPositionSeconds: candidate.last_position_seconds ?? null,
              formCtaAtSeconds: candidate.form_cta_at_seconds ?? null,
              durationSeconds: candidate.duration_seconds ?? 0,
            }
          : undefined,
      );
      if (text === null) {
        await db.prepare(
          `UPDATE webinar_journey_followups
           SET status = 'skipped', last_error = 'cta_reached', updated_at = ? WHERE id = ?`,
        ).bind(jstNow(), followup.id).run();
        continue;
      }
      await pushViaHarnessProxy(
        options.proxyBaseUrl,
        delivery.accessToken,
        friend.line_user_id,
        [{ type: 'text', text }],
        followup.retry_key,
        options.proxyDispatch,
      );
      const sentAt = jstNow();
      await db.prepare(
        `UPDATE webinar_journey_followups
         SET status = 'sent', sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      ).bind(sentAt, sentAt, followup.id).run();
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.prepare(
        `UPDATE webinar_journey_followups
         SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      ).bind(message.slice(0, 500), jstNow(), followup.id).run();
      console.error(
        'webinar journey followup error:',
        candidate.webinar_id,
        candidate.friend_id,
        kind,
        err,
      );
      failed++;
    }
  }
  return { sent, failed };
}
