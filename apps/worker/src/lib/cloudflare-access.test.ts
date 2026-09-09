import { describe, expect, test, vi } from 'vitest';

const jwtVerify = vi.hoisted(() => vi.fn());
const createRemoteJWKSet = vi.hoisted(() => vi.fn(() => 'jwks'));

vi.mock('jose', () => ({ createRemoteJWKSet, jwtVerify }));

import { verifyCloudflareAccessJwt } from './cloudflare-access.js';

const options = {
  token: 'assertion-is-never-logged',
  teamDomain: 'https://team.cloudflareaccess.com',
  audience: 'access-audience',
};

describe('verifyCloudflareAccessJwt', () => {
  test('uses Cloudflare JWKS with RS256, exact issuer and audience', async () => {
    jwtVerify.mockResolvedValueOnce({ payload: { email: ' Staff@Example.Test ' } });

    await expect(verifyCloudflareAccessJwt(options)).resolves.toEqual({
      ok: true, email: 'staff@example.test',
    });
    expect(createRemoteJWKSet).toHaveBeenCalledWith(
      new URL('https://team.cloudflareaccess.com/cdn-cgi/access/certs'),
    );
    expect(jwtVerify).toHaveBeenCalledWith(options.token, 'jwks', {
      algorithms: ['RS256'],
      issuer: options.teamDomain,
      audience: options.audience,
    });
  });

  test('does not accept a verified assertion without an email claim', async () => {
    jwtVerify.mockResolvedValueOnce({ payload: {} });
    await expect(verifyCloudflareAccessJwt(options)).resolves.toEqual({ ok: false, reason: 'missing_email' });
  });

  test('collapses JWT verification failures into a non-sensitive rejection', async () => {
    jwtVerify.mockRejectedValueOnce(new Error('expired assertion-is-never-logged'));
    await expect(verifyCloudflareAccessJwt(options)).resolves.toEqual({ ok: false, reason: 'invalid_token' });
  });
});
