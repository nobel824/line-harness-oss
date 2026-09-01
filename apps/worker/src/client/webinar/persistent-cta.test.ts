import { describe, expect, test } from 'vitest';
import { resolveCtaOpenTracking, resolvePersistentCta } from './persistent-cta.js';

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

describe('resolveCtaOpenTracking', () => {
  test('AC-3: 常時リンクは cta-click を送らず persistent_link を使う', () => {
    expect(resolveCtaOpenTracking(true)).toEqual({
      sendCtaClick: false,
      fieldName: 'persistent_link',
    });
  });

  test('AC-4: 通常 CTA は cta-click を送り fieldName を空にする', () => {
    expect(resolveCtaOpenTracking(false)).toEqual({
      sendCtaClick: true,
      fieldName: '',
    });
  });
});
