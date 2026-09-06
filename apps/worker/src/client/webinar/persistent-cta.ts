export interface PersistentCtaCardLike {
  kind: 'form' | 'url';
  formId: string | null;
  buttonLabel: string;
}

// フォームシートをどこから開いたか。cta_clicks と form_open の field_name が
// これで決まるので、経路を足すときは必ずここに足す。
export type CtaOpenSource = 'card' | 'persistent' | 'ended';

type CtaState<T> = {
  live: boolean;
  ctas?: readonly T[];
  cta?: unknown | null;
} | null | undefined;

function findFormCard<T extends PersistentCtaCardLike>(
  ctas: readonly T[] | undefined,
): T | null {
  return ctas?.find((card) => card.kind === 'form' && Boolean(card.formId)) ?? null;
}

export function resolvePersistentCta<T extends PersistentCtaCardLike>(
  state: CtaState<T>,
  activeCta: T | null,
  ctaVisible: boolean,
): T | null {
  if (!state?.live || activeCta || (ctaVisible && state.cta)) return null;
  return findFormCard(state.ctas);
}

// 終了画面のボタン。resolvePersistentCta と違い activeCta を除外条件にしない。
// activeCta は一度セットされると終了までクリアされないため、除外すると
// 「CTA が出たあとに完走した人」という最も多い経路でボタンが消える。
export function resolveEndedCta<T extends PersistentCtaCardLike>(
  state: CtaState<T>,
  activeCta: T | null,
): T | null {
  if (!state?.live) return null;
  if (activeCta && activeCta.kind === 'form' && activeCta.formId) return activeCta;
  return findFormCard(state.ctas);
}

export function resolveCtaOpenTracking(source: CtaOpenSource): {
  sendCtaClick: boolean;
  fieldName: string;
} {
  // cta_clicks は「配信中に CTA を押した」を表す既存の指標なので、
  // カード以外の経路では増やさず field_name だけで区別する。
  switch (source) {
    case 'persistent':
      return { sendCtaClick: false, fieldName: 'persistent_link' };
    case 'ended':
      return { sendCtaClick: false, fieldName: 'ended_screen' };
    default:
      return { sendCtaClick: true, fieldName: '' };
  }
}
