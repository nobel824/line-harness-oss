import { afterEach, describe, expect, test, vi } from 'vitest';
import { GoogleCalendarClient } from './google-calendar.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GoogleCalendarClient.getFreeBusy', () => {
  test('FreeBusyに出ない透明な終日予定も一日分のbusyとして返す', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/freeBusy')) {
        return new Response(JSON.stringify({
          calendars: {
            primary: {
              busy: [{
                start: '2026-08-27T07:00:00.000Z',
                end: '2026-08-27T07:15:00.000Z',
              }],
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        items: [{
          status: 'confirmed',
          transparency: 'transparent',
          start: { date: '2026-08-28' },
          end: { date: '2026-08-29' },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new GoogleCalendarClient({ calendarId: 'primary', accessToken: 'token' });

    await expect(client.getFreeBusy(
      '2026-08-27T15:00:00.000Z',
      '2026-08-28T15:00:00.000Z',
    )).resolves.toEqual([
      { start: '2026-08-27T07:00:00.000Z', end: '2026-08-27T07:15:00.000Z' },
      { start: '2026-08-27T15:00:00.000Z', end: '2026-08-28T15:00:00.000Z' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('singleEvents=true');
    expect(String(fetchMock.mock.calls[1][0])).toContain('timeZone=Asia%2FTokyo');
  });

  test('時刻指定予定・キャンセル済み・誕生日・勤務場所は終日補完の対象外', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/freeBusy')) {
        return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        items: [
          { start: { dateTime: '2026-08-28T11:00:00+09:00' }, end: { dateTime: '2026-08-28T12:00:00+09:00' } },
          { status: 'cancelled', start: { date: '2026-08-28' }, end: { date: '2026-08-29' } },
          { eventType: 'birthday', start: { date: '2026-08-28' }, end: { date: '2026-08-29' } },
          { eventType: 'workingLocation', start: { date: '2026-08-28' }, end: { date: '2026-08-29' } },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new GoogleCalendarClient({ calendarId: 'primary', accessToken: 'token' });

    await expect(client.getFreeBusy(
      '2026-08-27T15:00:00.000Z',
      '2026-08-28T15:00:00.000Z',
    )).resolves.toEqual([]);
  });
});

describe('GoogleCalendarClient.createEvent', () => {
  test('Google Meetを要求し、返されたMeet URLを返す', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'event-1',
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const client = new GoogleCalendarClient({
      calendarId: 'primary@example.com',
      accessToken: 'token',
    });

    const result = await client.createEvent({
      summary: '個別相談',
      start: '2026-08-20T02:00:00.000Z',
      end: '2026-08-20T02:15:00.000Z',
      addGoogleMeet: true,
      externalId: '0123456789abcdef0123456789abcdef',
    });

    expect(result).toEqual({
      eventId: 'event-1',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('conferenceDataVersion=1');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: '0123456789abcdef0123456789abcdef',
      conferenceData: {
        createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    });
  });

  test('同じexternalIdが既にあれば既存イベントを再取得し二重作成しない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('already exists', { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: '0123456789abcdef0123456789abcdef',
        hangoutLink: 'https://meet.google.com/existing-room',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new GoogleCalendarClient({ calendarId: 'primary', accessToken: 'token' });
    await expect(client.createEvent({
      summary: '個別相談',
      start: '2026-08-20T02:00:00.000Z',
      end: '2026-08-20T02:15:00.000Z',
      addGoogleMeet: true,
      externalId: '0123456789abcdef0123456789abcdef',
    })).resolves.toEqual({
      eventId: '0123456789abcdef0123456789abcdef',
      meetUrl: 'https://meet.google.com/existing-room',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/events/0123456789abcdef0123456789abcdef?conferenceDataVersion=1',
    );
  });

  test('Meet要求時にURLが返らなければ成功扱いにしない', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'event-without-meet' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new GoogleCalendarClient({ calendarId: 'primary', accessToken: 'token' });
    await expect(client.createEvent({
      summary: '個別相談',
      start: '2026-08-20T02:00:00.000Z',
      end: '2026-08-20T02:15:00.000Z',
      addGoogleMeet: true,
    })).rejects.toThrow('response missing Google Meet URL');
  });

  test('通常イベントは従来どおりconferenceDataを付けない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'event-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new GoogleCalendarClient({ calendarId: 'primary', accessToken: 'token' });
    await expect(client.createEvent({
      summary: '通常予約',
      start: '2026-08-20T02:00:00.000Z',
      end: '2026-08-20T02:15:00.000Z',
    })).resolves.toEqual({ eventId: 'event-2', meetUrl: undefined });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('conferenceDataVersion');
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('conferenceData');
  });
});

/**
 * FreeBusy と、終日予定を補完する events.list の両方に応答する fetch モック。
 * Response を呼び出しごとに作り直すのが要点で、同じインスタンスを
 * mockResolvedValue で使い回すと 2 回目の body 読み取りが
 * "Body has already been read" で落ちる。
 */
function freeBusyFetch(freeBusyBody: unknown) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const body = String(input).includes('/freeBusy') ? freeBusyBody : { items: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('GoogleCalendarClient.getFreeBusy', () => {
  const timeMin = '2026-08-20T00:00:00.000Z';
  const timeMax = '2026-08-21T00:00:00.000Z';

  test('busyCalendarIds 未指定なら主カレンダーだけを問い合わせ、主カレンダーの busy を返す', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(freeBusyFetch({
      calendars: {
        'primary@example.com': {
          busy: [{ start: '2026-08-20T01:00:00.000Z', end: '2026-08-20T02:00:00.000Z' }],
        },
      },
    }));
    const client = new GoogleCalendarClient({
      calendarId: 'primary@example.com',
      accessToken: 'token',
    });

    await expect(client.getFreeBusy(timeMin, timeMax)).resolves.toEqual([
      { start: '2026-08-20T01:00:00.000Z', end: '2026-08-20T02:00:00.000Z' },
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      timeMin,
      timeMax,
      items: [{ id: 'primary@example.com' }],
    });
  });

  test('busyCalendarIds が空配列なら主カレンダーだけを問い合わせる', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      freeBusyFetch({ calendars: { primary: { busy: [] } } }),
    );
    const client = new GoogleCalendarClient({
      calendarId: 'primary',
      accessToken: 'token',
      busyCalendarIds: [],
    });

    await expect(client.getFreeBusy(timeMin, timeMax)).resolves.toEqual([]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body)).items).toEqual([{ id: 'primary' }]);
  });

  test('補助カレンダーを重複除去して問い合わせ、busy をカレンダー順に連結する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(freeBusyFetch({
      calendars: {
        primary: { busy: [{ start: '2026-08-20T01:00:00.000Z', end: '2026-08-20T02:00:00.000Z' }] },
        secondary: { busy: [{ start: '2026-08-20T03:00:00.000Z', end: '2026-08-20T04:00:00.000Z' }] },
        tertiary: { busy: [{ start: '2026-08-20T05:00:00.000Z', end: '2026-08-20T06:00:00.000Z' }] },
      },
    }));
    const client = new GoogleCalendarClient({
      calendarId: 'primary',
      accessToken: 'token',
      busyCalendarIds: ['secondary', 'primary', 'tertiary', 'secondary'],
    });

    await expect(client.getFreeBusy(timeMin, timeMax)).resolves.toEqual([
      { start: '2026-08-20T01:00:00.000Z', end: '2026-08-20T02:00:00.000Z' },
      { start: '2026-08-20T03:00:00.000Z', end: '2026-08-20T04:00:00.000Z' },
      { start: '2026-08-20T05:00:00.000Z', end: '2026-08-20T06:00:00.000Z' },
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body)).items).toEqual([
      { id: 'primary' },
      { id: 'secondary' },
      { id: 'tertiary' },
    ]);
  });

  test('補助カレンダーの errors は警告してスキップし、主カレンダーの busy を返す', async () => {
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(freeBusyFetch({
      calendars: {
        primary: { busy: [{ start: '2026-08-20T01:00:00.000Z', end: '2026-08-20T02:00:00.000Z' }] },
        secondary: {
          busy: [{ start: '2026-08-20T03:00:00.000Z', end: '2026-08-20T04:00:00.000Z' }],
          errors: [{ domain: 'calendar', reason: 'notFound' }],
        },
      },
    }));
    const client = new GoogleCalendarClient({
      calendarId: 'primary',
      accessToken: 'token',
      busyCalendarIds: ['secondary'],
    });

    await expect(client.getFreeBusy(timeMin, timeMax)).resolves.toEqual([
      { start: '2026-08-20T01:00:00.000Z', end: '2026-08-20T02:00:00.000Z' },
    ]);
    expect(warnMock).toHaveBeenCalled();
  });

  test('主カレンダーの errors は例外にする', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        calendars: {
          primary: { errors: [{ domain: 'calendar', reason: 'forbidden' }] },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const client = new GoogleCalendarClient({
      calendarId: 'primary',
      accessToken: 'token',
    });

    await expect(client.getFreeBusy(timeMin, timeMax)).rejects.toThrow(
      'Google FreeBusy calendar error for primary',
    );
  });
});
