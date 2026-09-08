import { describe, expect, test } from 'vitest';
import { deriveRetryKey } from './retry-key.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveRetryKey', () => {
  test('LINE が受け付ける UUID 形式になる', async () => {
    // X-Line-Retry-Key は UUID 以外だと LINE が 400 を返す。
    // 「registration id + 用途」をそのまま渡して 3 セッション分の前日リマインドを
    // 落とした実績があるので、形式はテストで固定する。
    expect(await deriveRetryKey('4f0b1f4e-1f7a-4a2e-9c1d-2f6b7a0c3d51:day_before')).toMatch(UUID);
  });

  test('同じ seed からは必ず同じキーになる', async () => {
    // 送信成功後・DB 更新前に worker が落ちても、次 tick で LINE 側が重複を弾けること。
    const seed = 'reg-1:day_before';
    expect(await deriveRetryKey(seed)).toBe(await deriveRetryKey(seed));
  });

  test('用途が違えば別のキーになる', async () => {
    // 前日リマインドと開始5分前リマインドが同じキーになると、
    // LINE の重複排除で片方が黙って捨てられる。
    const id = '4f0b1f4e-1f7a-4a2e-9c1d-2f6b7a0c3d51';
    expect(await deriveRetryKey(`${id}:day_before`)).not.toBe(await deriveRetryKey(id));
  });

  test('registration が違えば別のキーになる', async () => {
    expect(await deriveRetryKey('reg-1:day_before')).not.toBe(await deriveRetryKey('reg-2:day_before'));
  });

  test('元の id をそのまま含まない', async () => {
    // id を切り貼りして UUID に見せかける実装だと、別 registration と衝突しうる。
    const id = '4f0b1f4e-1f7a-4a2e-9c1d-2f6b7a0c3d51';
    expect(await deriveRetryKey(`${id}:day_before`)).not.toContain('4f0b1f4e');
  });
});
