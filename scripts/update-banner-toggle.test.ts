import { afterEach, describe, expect, test, vi } from 'vitest';
import { runBrowserSelfUpdateEffect } from '../apps/web/src/components/update/browser-update-policy';

describe('update banner deployment toggle', () => {
  const originalValue = process.env.NEXT_PUBLIC_UPDATE_BANNER_ENABLED;

  afterEach(() => {
    if (originalValue === undefined) delete process.env.NEXT_PUBLIC_UPDATE_BANNER_ENABLED;
    else process.env.NEXT_PUBLIC_UPDATE_BANNER_ENABLED = originalValue;
  });

  test.each([undefined, 'false', 'true'])(
    'does not start the browser update effect when env is %s',
    (value) => {
      if (value === undefined) delete process.env.NEXT_PUBLIC_UPDATE_BANNER_ENABLED;
      else process.env.NEXT_PUBLIC_UPDATE_BANNER_ENABLED = value;

      const fetchVersionAndManifest = vi.fn();
      const cleanup = runBrowserSelfUpdateEffect(fetchVersionAndManifest);

      expect(cleanup).toBeUndefined();
      expect(fetchVersionAndManifest).not.toHaveBeenCalled();
    },
  );
});
