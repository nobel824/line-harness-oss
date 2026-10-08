import { Hono, type Context } from 'hono';
import { getActiveStaffByEmail } from '@line-crm/db';
import type { Env } from '../index.js';
import { adminSessionCookie, csrfCookie } from '../middleware/auth.js';
import {
  parseAllowedOrigins,
  resolveAdminAuthConfig,
  resolveAdminBrowserAuthConfig,
} from '../middleware/admin-auth-config.js';
import { verifyCloudflareAccessJwt } from '../lib/cloudflare-access.js';

export const adminAccess = new Hono<Env>();

const LOG = '[admin-access]';

function adminHomeUrl(env: Env['Bindings']): string {
  const [firstAllowedOrigin] = parseAllowedOrigins(env);
  const configured = env.ADMIN_PUBLIC_URL?.trim();
  let adminPublicUrl: string | null = null;
  if (configured) {
    try {
      const url = new URL(configured);
      adminPublicUrl = `${url.origin}${url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')}`;
    } catch {
      // Fall through to the CORS allowlist only; never use request input.
    }
  }
  if (firstAllowedOrigin) {
    // Keep the admin base path for same-origin three-surfaces deployments, but
    // preserve the historical Pages allowlist destination when it is separate.
    return adminPublicUrl && new URL(adminPublicUrl).origin === firstAllowedOrigin
      ? adminPublicUrl
      : firstAllowedOrigin;
  }
  return adminPublicUrl ?? '/';
}

function denied(c: Context<Env>) {
  return c.json({ success: false, error: 'Access login was not accepted.' }, 403);
}

/**
 * GET /admin/access — exchange a verified Cloudflare Access assertion for the
 * existing HttpOnly staff API-key session. Access identifies the person; the
 * staff_members row remains the sole authorization source.
 */
adminAccess.get('/admin/access', async (c) => {
  const browserAuth = resolveAdminBrowserAuthConfig(c.env, {
    requestOrigin: new URL(c.req.url).origin,
  });
  if (browserAuth.mode === 'api_key') return c.notFound();
  if (!browserAuth.accessTeamDomain || !browserAuth.accessAudience) {
    console.error(`${LOG} refused — Cloudflare Access configuration is incomplete`);
    return c.json({ success: false, error: 'Cloudflare Access login is not configured.' }, 503);
  }

  const cookieConfig = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (cookieConfig.misconfigured) {
    console.error(`${LOG} refused — misconfigured topology: ${cookieConfig.misconfigured}`);
    return c.json({ success: false, error: cookieConfig.misconfigured }, 503);
  }

  const assertion = c.req.header('Cf-Access-Jwt-Assertion')?.trim() ?? '';
  if (!assertion) {
    console.warn(`${LOG} rejected reason=missing_assertion staff_id=- auth=access`);
    return denied(c);
  }

  const verified = await verifyCloudflareAccessJwt({
    token: assertion,
    teamDomain: browserAuth.accessTeamDomain,
    audience: browserAuth.accessAudience,
  });
  if (!verified.ok) {
    console.warn(`${LOG} rejected reason=${verified.reason} staff_id=- auth=access`);
    return denied(c);
  }

  const match = await getActiveStaffByEmail(c.env.DB, verified.email);
  if (match.kind !== 'found') {
    console.warn(`${LOG} rejected reason=${match.kind} staff_id=- auth=access`);
    return denied(c);
  }

  const csrfToken = crypto.randomUUID();
  c.header('Set-Cookie', adminSessionCookie(match.staff.api_key, cookieConfig.sameSite), { append: true });
  c.header('Set-Cookie', csrfCookie(csrfToken, cookieConfig.sameSite), { append: true });
  console.log(`${LOG} accepted staff_id=${match.staff.id} auth=access`);
  const response = c.redirect(adminHomeUrl(c.env), 302);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
});
