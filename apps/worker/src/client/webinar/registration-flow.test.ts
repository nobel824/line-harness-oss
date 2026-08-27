import { describe, expect, test } from 'vitest';
import { sessionPickAction, submitFormThenRegister } from './registration-flow.js';

describe('sessionPickAction', () => {
  test('予約済みの回を押しても noop で、register 相当の action にならない', () => {
    expect(sessionPickAction(100, 100, true)).toEqual({ type: 'noop' });
    expect(sessionPickAction(100, 100, false)).toEqual({ type: 'noop' });
  });

  test('フォームがある回は open-form になり、押しただけでは register しない', () => {
    expect(sessionPickAction(200, null, true)).toEqual({
      type: 'open-form',
      sessionStartAt: 200,
    });
    expect(sessionPickAction(200, 100, true)).toEqual({
      type: 'open-form',
      sessionStartAt: 200,
    });
  });

  test('フォーム未設定の回は確認ダイアログになり、押しただけでは register しない', () => {
    expect(sessionPickAction(200, null, false)).toEqual({
      type: 'open-confirm',
      sessionStartAt: 200,
    });
  });
});

describe('submitFormThenRegister', () => {
  test('シート送信で submit → register の順に飛ぶ', async () => {
    const order: string[] = [];
    const result = await submitFormThenRegister({
      submit: async () => {
        order.push('submit');
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      },
      register: async () => {
        order.push('register');
      },
    });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['submit', 'register']);
  });

  test('submit が失敗したら register は飛ばない', async () => {
    const order: string[] = [];
    const result = await submitFormThenRegister({
      submit: async () => {
        order.push('submit');
        return new Response(JSON.stringify({ success: false, error: '必須項目が未入力です' }), {
          status: 400,
        });
      },
      register: async () => {
        order.push('register');
      },
    });
    expect(result).toEqual({ ok: false, error: '必須項目が未入力です' });
    expect(order).toEqual(['submit']);
  });

  test('submit の通信失敗でも register は飛ばない', async () => {
    const order: string[] = [];
    const result = await submitFormThenRegister({
      submit: async () => {
        order.push('submit');
        throw new Error('network');
      },
      register: async () => {
        order.push('register');
      },
    });
    expect(result.ok).toBe(false);
    expect(order).toEqual(['submit']);
  });
});
