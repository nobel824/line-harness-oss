import { describe, expect, test, vi } from 'vitest';
import { RegistrationCompletionCloseButton } from './registration-completion.js';
import {
  confirmRegistrationResult,
  registrationCompletionHeading,
  registrationSubmitView,
  sessionPickAction,
  shouldShowSessionPicker,
  submitFormThenRegister,
} from './registration-flow.js';

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

describe('shouldShowSessionPicker', () => {
  test('候補がある未ライブ状態では表示する', () => {
    expect(shouldShowSessionPicker(false, [200], null)).toBe(true);
  });

  test('予約済みで候補が空でも表示する', () => {
    expect(shouldShowSessionPicker(false, [], 100)).toBe(true);
  });

  test('未予約で候補も空なら表示しない', () => {
    expect(shouldShowSessionPicker(false, [], null)).toBe(false);
  });

  test('ライブ中は候補や予約の有無にかかわらず表示しない', () => {
    expect(shouldShowSessionPicker(true, [200], 100)).toBe(false);
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

describe('confirmRegistrationResult', () => {
  test('(a) 解決するonConfirmでは成功結果を返す', async () => {
    const result = await confirmRegistrationResult(async () => undefined);

    expect(result).toEqual({ ok: true });
  });

  test('(b) rejectするonConfirmでは所定のエラー結果を返す', async () => {
    const result = await confirmRegistrationResult(async () => {
      throw new Error('network');
    });

    expect(result).toEqual({
      ok: false,
      error: '送信に失敗しました。もう一度お試しください。',
    });
  });

  test('(c) 成否の結果をregistrationSubmitViewに通すと表示状態へ変換される', async () => {
    const completion = { sessionStartAt: 300, changing: true };
    const successResult = await confirmRegistrationResult(async () => undefined);
    const failureResult = await confirmRegistrationResult(async () => {
      throw new Error('network');
    });

    expect(registrationSubmitView(successResult, completion)).toEqual({
      type: 'complete',
      completion,
    });
    expect(registrationSubmitView(failureResult, completion)).toEqual({
      type: 'error',
      error: '送信に失敗しました。もう一度お試しください。',
    });
  });
});

describe('registrationSubmitView', () => {
  // コンポーネントのレンダリングテスト基盤がないため、シートが選ぶ表示状態を検証する。
  test('(a) PreRegistrationSheetの送信成功では完了表示になり、onCloseは呼ばれない', async () => {
    const onClose = vi.fn();
    const result = await submitFormThenRegister({
      submit: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      register: async () => undefined,
    });
    const view = registrationSubmitView(result, { sessionStartAt: 200, changing: false });

    expect(view).toEqual({
      type: 'complete',
      completion: { sessionStartAt: 200, changing: false },
    });
    expect(registrationCompletionHeading(false)).toBe('申し込みが完了しました');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('(b) 完了表示では自動closeせず、明示的な閉じる操作だけがonCloseを呼ぶ', () => {
    const onClose = vi.fn();
    const view = registrationSubmitView(
      { ok: true },
      { sessionStartAt: 200, changing: false },
    );

    expect(view.type).toBe('complete');
    expect(onClose).not.toHaveBeenCalled();
    const closeButton = RegistrationCompletionCloseButton({ onClose });
    expect(closeButton.type).toBe('button');
    expect(closeButton.props.children).toBe('閉じる');
    closeButton.props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('(c) 送信失敗では完了表示にならず、エラー表示のまま', async () => {
    const result = await submitFormThenRegister({
      submit: async () => new Response(JSON.stringify({ success: false, error: '必須項目が未入力です' }), {
        status: 400,
      }),
      register: async () => undefined,
    });
    const view = registrationSubmitView(result, { sessionStartAt: 200, changing: false });

    expect(view).toEqual({ type: 'error', error: '必須項目が未入力です' });
    expect(view.type).not.toBe('complete');
  });

  test('(d) ConfirmRegistrationSheetの送信成功でも変更完了表示の分岐になる', async () => {
    const result = await Promise.resolve({ ok: true } as const);
    const view = registrationSubmitView(result, { sessionStartAt: 300, changing: true });

    expect(view).toEqual({
      type: 'complete',
      completion: { sessionStartAt: 300, changing: true },
    });
    expect(registrationCompletionHeading(true)).toBe('変更が完了しました');
  });
});
