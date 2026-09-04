// src/client/lobby/__tests__/tokenUtils.test.ts
import { isAccessTokenExpired } from '../shared/tokenUtils';

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  // Signature segment content doesn't matter -- isAccessTokenExpired never verifies it.
  return `${header}.${body}.fakesignature`;
}

describe('isAccessTokenExpired', () => {
  it('returns true for an expired exp claim', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: nowSeconds - 3600 });

    expect(isAccessTokenExpired(token)).toBe(true);
  });

  it('returns false for a future exp claim well outside the skew window', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: nowSeconds + 3600 });

    expect(isAccessTokenExpired(token)).toBe(false);
  });

  it('returns true when exp falls within the default skew window', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: nowSeconds + 10 }); // within default 30s skew

    expect(isAccessTokenExpired(token)).toBe(true);
  });

  it('respects a custom skew window', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: nowSeconds + 45 });

    expect(isAccessTokenExpired(token, 30)).toBe(false);
    expect(isAccessTokenExpired(token, 60)).toBe(true);
  });

  it('fails closed (true) for a JWT-shaped token with an unparseable payload', () => {
    const malformed = 'aaaa.not-valid-base64!!!.signature';

    expect(isAccessTokenExpired(malformed)).toBe(true);
  });

  it('fails closed (true) for a JWT-shaped token missing a numeric exp claim', () => {
    const token = makeJwt({ userId: 'abc' });

    expect(isAccessTokenExpired(token)).toBe(true);
  });

  it('treats a non-JWT-shaped token (dev-auth sentinel) as not expired', () => {
    expect(isAccessTokenExpired('dev-token')).toBe(false);
  });

  it('treats null/undefined/empty tokens as expired', () => {
    expect(isAccessTokenExpired(null)).toBe(true);
    expect(isAccessTokenExpired(undefined)).toBe(true);
    expect(isAccessTokenExpired('')).toBe(true);
  });

  it('never throws for garbage input', () => {
    expect(() => isAccessTokenExpired('not..a.valid..jwt....')).not.toThrow();
    expect(() => isAccessTokenExpired('a.b.c.d.e')).not.toThrow();
  });
});
