export type SessionPickAction =
  | { type: 'noop' }
  | { type: 'open-form'; sessionStartAt: number }
  | { type: 'open-confirm'; sessionStartAt: number };

export interface RegistrationCompletion {
  sessionStartAt: number;
  changing: boolean;
}

export type RegistrationSubmitView =
  | { type: 'complete'; completion: RegistrationCompletion }
  | { type: 'error'; error: string };

export function registrationSubmitView(
  result: { ok: true } | { ok: false; error: string },
  completion: RegistrationCompletion,
): RegistrationSubmitView {
  return result.ok
    ? { type: 'complete', completion }
    : { type: 'error', error: result.error };
}

export async function confirmRegistrationResult(
  onConfirm: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await onConfirm();
    return { ok: true };
  } catch {
    return { ok: false, error: '送信に失敗しました。もう一度お試しください。' };
  }
}

export function registrationCompletionHeading(changing: boolean): string {
  return changing ? '変更が完了しました' : '申し込みが完了しました';
}

export function sessionPickAction(
  sessionStartAt: number,
  registered: number | null,
  hasPreRegistrationForm: boolean,
): SessionPickAction {
  if (registered === sessionStartAt) return { type: 'noop' };
  if (hasPreRegistrationForm) return { type: 'open-form', sessionStartAt };
  return { type: 'open-confirm', sessionStartAt };
}

export function shouldShowSessionPicker(
  live: boolean,
  upcoming: number[] | undefined,
  registeredSessionAt: number | null,
): boolean {
  return !live && ((upcoming?.length ?? 0) > 0 || registeredSessionAt !== null);
}

export async function submitFormThenRegister(opts: {
  submit: () => Promise<Response>;
  register: () => Promise<unknown>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  let submitRes: Response;
  try {
    submitRes = await opts.submit();
  } catch {
    return { ok: false, error: '送信に失敗しました。通信環境をご確認ください。' };
  }
  let json: { success?: boolean; error?: string };
  try {
    json = (await submitRes.json()) as { success?: boolean; error?: string };
  } catch {
    return { ok: false, error: '送信に失敗しました。もう一度お試しください。' };
  }
  if (!submitRes.ok || json.success === false) {
    return { ok: false, error: json.error || '送信に失敗しました。もう一度お試しください。' };
  }
  try {
    await opts.register();
    return { ok: true };
  } catch {
    return { ok: false, error: '送信に失敗しました。もう一度お試しください。' };
  }
}
