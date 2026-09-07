import { describe, expect, test } from 'vitest';
import { resolveCtaOpenTracking, resolveEndedCta, resolvePersistentCta } from './persistent-cta.js';

type Card = {
  id: string;
  kind: 'form' | 'url';
  formId: string | null;
  buttonLabel: string;
};

const formCard: Card = {
  id: 'form-cta',
  kind: 'form',
  formId: 'form-1',
  buttonLabel: '無料相談を予約する',
};
const urlCard: Card = {
  id: 'url-cta',
  kind: 'url',
  formId: null,
  buttonLabel: '資料を見る',
};

function liveState(ctas: Card[] = [formCard], cta: unknown | null = null) {
  return { live: true, ctas, cta };
}

describe('resolvePersistentCta', () => {
  test('AC-1: form CTA を持つライブ state では buttonLabel のカードを返す', () => {
    const result = resolvePersistentCta(liveState(), null, false);

    expect(result).toBe(formCard);
    expect(result?.buttonLabel).toBe('無料相談を予約する');
  });

  test('formId のある最初の form カードを使う', () => {
    const secondForm: Card = { ...formCard, id: 'form-cta-2', buttonLabel: '別の相談' };
    const result = resolvePersistentCta(
      liveState([{ ...urlCard }, { ...formCard, formId: null }, secondForm]),
      null,
      false,
    );

    expect(result).toBe(secondForm);
  });

  test('ライブでない state や form CTA が無い state では表示しない', () => {
    expect(resolvePersistentCta({ live: false, ctas: [formCard] }, null, false)).toBeNull();
    expect(resolvePersistentCta(liveState([urlCard]), null, false)).toBeNull();
  });

  test('AC-2: activeCta が設定されると表示しない', () => {
    expect(resolvePersistentCta(liveState(), formCard, false)).toBeNull();
  });

  test('レガシー下部 CTA が表示中なら表示しない', () => {
    expect(resolvePersistentCta(liveState(undefined, { label: '相談' }), null, true)).toBeNull();
  });
});

describe('resolveEndedCta', () => {
  test('AC-5: 動画中に出た CTA カードがそのまま終了画面のボタンになる', () => {
    // activeCta は一度セットされたら ended でもクリアされないため、
    // resolvePersistentCta と違って activeCta を除外条件にしてはいけない。
    expect(resolveEndedCta(liveState(), formCard)).toBe(formCard);
  });

  test('AC-6: CTA が一度も出ないまま終了しても form カードを拾う', () => {
    expect(resolveEndedCta(liveState(), null)).toBe(formCard);
  });

  test('form CTA が無いウェビナーでは出さない', () => {
    expect(resolveEndedCta(liveState([urlCard]), null)).toBeNull();
    expect(resolveEndedCta(liveState([{ ...formCard, formId: null }]), null)).toBeNull();
  });

  test('ライブでない state では出さない', () => {
    expect(resolveEndedCta({ live: false, ctas: [formCard] }, null)).toBeNull();
    expect(resolveEndedCta(null, null)).toBeNull();
  });

  test('url カードが activeCta のときはフォームカードへ落とす', () => {
    expect(resolveEndedCta(liveState([urlCard, formCard]), urlCard)).toBe(formCard);
  });
});

describe('resolveCtaOpenTracking', () => {
  test('AC-3: 常時リンクは cta-click を送らず persistent_link を使う', () => {
    expect(resolveCtaOpenTracking('persistent')).toEqual({
      sendCtaClick: false,
      fieldName: 'persistent_link',
    });
  });

  test('AC-4: 通常 CTA は cta-click を送り fieldName を空にする', () => {
    expect(resolveCtaOpenTracking('card')).toEqual({
      sendCtaClick: true,
      fieldName: '',
    });
  });

  test('AC-7: 終了画面は cta-click を送らず ended_screen で区別する', () => {
    // cta_clicks は「配信中に CTA を押した」を表す既存の指標なので増やさない。
    expect(resolveCtaOpenTracking('ended')).toEqual({
      sendCtaClick: false,
      fieldName: 'ended_screen',
    });
  });

  test('fieldName はサーバー側バリデーション /^[A-Za-z0-9_]+$/ を通る', () => {
    for (const source of ['persistent', 'ended'] as const) {
      expect(resolveCtaOpenTracking(source).fieldName).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });
});
