/**
 * Ref codes handed out by the product itself (not tenant campaigns).
 *
 * 'dashboard' is what the admin dashboard's friend-add card rides as the
 * provenance marker (/r/dashboard?account=...). Reserved refs are:
 *   - rejected at entry-route create/update (routes/entry-routes.ts)
 *   - excluded from campaign attribution side effects (applyRefAttribution)
 *     while still being written to friends.ref_code / ref_tracking, so
 *     provenance survives but a pre-existing colliding campaign row can
 *     never fire its tags/scenarios from a dashboard-copied link.
 */
export const SAGARIFUJI_THREADS_REF = 'sagarifuji-threads';
export const SAGARIFUJI_LINE_CHANNEL_ID = '2011217182';
export const RESERVED_REF_CODES = new Set(['dashboard', SAGARIFUJI_THREADS_REF]);

export function isSagarifujiThreadsRef(ref: string): boolean {
  return ref.toLowerCase() === SAGARIFUJI_THREADS_REF;
}

/** Account hints from query/state are not proof of the processing account. */
export function canRecordRefForAccount(
  ref: string,
  verifiedAccount: { id: string; channel_id: string } | null,
  friendAccountId: string | null | undefined,
): boolean {
  return !isSagarifujiThreadsRef(ref) || (
    ref === SAGARIFUJI_THREADS_REF &&
    verifiedAccount?.channel_id === SAGARIFUJI_LINE_CHANNEL_ID &&
    friendAccountId === verifiedAccount.id
  );
}

export function isReservedRef(ref: string): boolean {
  return RESERVED_REF_CODES.has(ref.toLowerCase());
}
