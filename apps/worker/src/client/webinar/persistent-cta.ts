export interface PersistentCtaCardLike {
  kind: 'form' | 'url';
  formId: string | null;
  buttonLabel: string;
}

export function resolvePersistentCta<T extends PersistentCtaCardLike>(
  state: {
    live: boolean;
    ctas?: readonly T[];
    cta?: unknown | null;
  } | null | undefined,
  activeCta: T | null,
  ctaVisible: boolean,
): T | null {
  if (!state?.live || activeCta || (ctaVisible && state.cta)) return null;
  return state.ctas?.find((card) => card.kind === 'form' && Boolean(card.formId)) ?? null;
}

export function resolveCtaOpenTracking(persistent: boolean): {
  sendCtaClick: boolean;
  fieldName: string;
} {
  return persistent
    ? { sendCtaClick: false, fieldName: 'persistent_link' }
    : { sendCtaClick: true, fieldName: '' };
}
