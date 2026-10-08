import { createRemoteJWKSet, jwtVerify } from 'jose';

export type CloudflareAccessVerification =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid_token' | 'missing_email' };

type VerifyOptions = {
  token: string;
  teamDomain: string;
  audience: string;
};

// A Worker isolate commonly serves many requests. Reusing the remote JWKS
// resolver lets jose retain its normal cache while keeping keys scoped to the
// validated team origin.
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain));
    jwksByTeam.set(teamDomain, jwks);
  }
  return jwks;
}

/** Verify a Cloudflare Access assertion; callers must never log the token. */
export async function verifyCloudflareAccessJwt(
  options: VerifyOptions,
): Promise<CloudflareAccessVerification> {
  try {
    const { payload } = await jwtVerify(options.token, jwksFor(options.teamDomain), {
      algorithms: ['RS256'],
      issuer: options.teamDomain,
      audience: options.audience,
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email ? { ok: true, email } : { ok: false, reason: 'missing_email' };
  } catch {
    // Signature, issuer, audience, expiry and nbf failures intentionally share
    // one reason. Error details may contain attacker-controlled JWT material.
    return { ok: false, reason: 'invalid_token' };
  }
}
