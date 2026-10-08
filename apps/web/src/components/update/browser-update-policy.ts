/**
 * Browser self-update is intentionally locked off.
 *
 * The current /admin/update/* flow has no browser-safe server-side
 * authentication boundary. This must not read an environment toggle: changing
 * deployment configuration alone must never make the unsafe flow reachable.
 * Re-enabling it requires a code change here together with updated behavior
 * tests after server-side authentication has been implemented and reviewed.
 */
const BROWSER_SELF_UPDATE_ENABLED = false

export function runBrowserSelfUpdateEffect(
  effect: () => void | (() => void),
): void | (() => void) {
  if (!BROWSER_SELF_UPDATE_ENABLED) return
  return effect()
}
