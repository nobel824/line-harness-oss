import { describe, it, expect } from 'vitest';
import { computeEngagementRate } from './engagement-rate.js';

describe('computeEngagementRate', () => {
  it('delivered>0 かつ unique=0 は「0%」の実測値として 0 を返す（null に落とさない）', () => {
    expect(computeEngagementRate(200, 0)).toBe(0);
  });

  it('通常のレートを計算する', () => {
    expect(computeEngagementRate(200, 50)).toBe(0.25);
    expect(computeEngagementRate(4, 1)).toBe(0.25);
  });

  it('unique が null（insight 未取得）なら null', () => {
    expect(computeEngagementRate(200, null)).toBeNull();
  });

  it('delivered が null（送達数不明）なら null', () => {
    expect(computeEngagementRate(null, 10)).toBeNull();
  });

  it('delivered が 0（未送達 / 分母なし）なら 0 除算を避けて null', () => {
    expect(computeEngagementRate(0, 0)).toBeNull();
    expect(computeEngagementRate(0, 5)).toBeNull();
  });

  it('delivered が負値の異常系でも null', () => {
    expect(computeEngagementRate(-1, 5)).toBeNull();
  });
});
