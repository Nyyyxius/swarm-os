import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { makeAuthMiddleware, PANEL_COOKIE } from './auth.js';

const TOKEN = 'super-secret-token';

/** Minimal Express req stand-in: header lookup + raw cookie + path. */
function mkReq(opts: { header?: string; cookie?: string; path?: string }): Request {
  return {
    path: opts.path ?? '/orchestrators',
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    header(name: string): string | undefined {
      return name.toLowerCase() === 'x-auth-token' ? opts.header : undefined;
    },
  } as unknown as Request;
}

/** Minimal Express res stand-in capturing status + json. */
function mkRes(): { res: Response; status: () => number | null } {
  let code: number | null = null;
  const res = {
    status(c: number) {
      code = c;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  return { res, status: () => code };
}

describe('makeAuthMiddleware — header', () => {
  it('passes with a valid X-Auth-Token header (any path)', () => {
    const next = vi.fn();
    const { res, status } = mkRes();
    makeAuthMiddleware(TOKEN)(mkReq({ header: TOKEN, path: '/orchestrators' }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status()).toBeNull();
  });

  it('401s with a missing or wrong header (no cookie)', () => {
    for (const header of [undefined, 'nope']) {
      const next = vi.fn();
      const { res, status } = mkRes();
      makeAuthMiddleware(TOKEN)(mkReq({ header, path: '/orchestrators' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(status()).toBe(401);
    }
  });
});

describe('makeAuthMiddleware — panel cookie (feature B.3)', () => {
  it('accepts the cookie as an alternative on the /plugin-api/ zone', () => {
    const next = vi.fn();
    const { res, status } = mkRes();
    makeAuthMiddleware(TOKEN)(
      mkReq({ cookie: `${PANEL_COOKIE}=${TOKEN}`, path: '/plugin-api/echo/panel' }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status()).toBeNull();
  });

  it('decodes a url-encoded cookie value', () => {
    const raw = 'tok/with+special=chars';
    const next = vi.fn();
    const { res, status } = mkRes();
    makeAuthMiddleware(raw)(
      mkReq({
        cookie: `${PANEL_COOKIE}=${encodeURIComponent(raw)}`,
        path: '/plugin-api/echo/panel',
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status()).toBeNull();
  });

  it('does NOT accept the cookie outside the /plugin-api/ zone', () => {
    const next = vi.fn();
    const { res, status } = mkRes();
    makeAuthMiddleware(TOKEN)(
      mkReq({ cookie: `${PANEL_COOKIE}=${TOKEN}`, path: '/orchestrators' }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });

  it('401s on a wrong cookie value even on the plugin-api zone', () => {
    const next = vi.fn();
    const { res, status } = mkRes();
    makeAuthMiddleware(TOKEN)(
      mkReq({ cookie: `${PANEL_COOKIE}=wrong`, path: '/plugin-api/echo/panel' }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });

  it('ignores an unrelated cookie', () => {
    const next = vi.fn();
    const { res, status } = mkRes();
    makeAuthMiddleware(TOKEN)(
      mkReq({ cookie: `other=${TOKEN}`, path: '/plugin-api/echo/panel' }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });
});
