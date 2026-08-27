export type SessionPickAction =
  | { type: 'noop' }
  | { type: 'open-form'; sessionStartAt: number }
  | { type: 'open-confirm'; sessionStartAt: number };

export function sessionPickAction(
  sessionStartAt: number,
  registered: number | null,
  hasPreRegistrationForm: boolean,
): SessionPickAction {
  if (registered === sessionStartAt) return { type: 'noop' };
  if (hasPreRegistrationForm) return { type: 'open-form', sessionStartAt };
  return { type: 'open-confirm', sessionStartAt };
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
