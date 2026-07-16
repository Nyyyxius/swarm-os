import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'node:crypto';

const HEADER = 'x-auth-token';

/**
 * Feature B.3 — iframe-friendly auth for plugin UI panels.
 *
 * An `<iframe src="/plugin-api/<name>/<path>">` cannot send the `X-Auth-Token`
 * HEADER, so the SPA also mirrors the token into a cookie (`document.cookie`,
 * `Path=/plugin-api/; SameSite=Strict`). The gate accepts that cookie as an
 * ALTERNATIVE to the header, but ONLY for requests under the plugin-api zone
 * (`PLUGIN_API_PREFIX`) — belt-and-suspenders with the cookie's own path scope,
 * so a cookie can never authenticate `/orchestrators`, `/plugins`, etc.
 *
 * Why a cookie and not `?token=` in the URL: the swarm-os token grants full API
 * access, so keeping it out of URLs avoids referrer / history / access-log
 * leaks. `SameSite=Strict` blocks cross-site attachment (CSRF); `Path` scoping
 * means the browser only ever sends it to the plugin-api zone.
 */
export const PANEL_COOKIE = 'swarm_os_token';
const PLUGIN_API_PREFIX = '/plugin-api/';

/** Constant-time string comparison to avoid timing leaks. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Read a single cookie value from the raw `Cookie` header (no dependency). */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function makeAuthMiddleware(token: string) {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    const header = req.header(HEADER);
    if (header && safeEqual(header, token)) {
      next();
      return;
    }
    // Cookie fallback — plugin UI panels only (iframe can't set a header).
    if (req.path.startsWith(PLUGIN_API_PREFIX)) {
      const cookie = readCookie(req, PANEL_COOKIE);
      if (cookie && safeEqual(cookie, token)) {
        next();
        return;
      }
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}

// ---- WS single-use tickets -------------------------------------------------

interface Ticket {
  sessionId: string;
  createdAt: number;
  /** 'terminal' (single session) or 'events' (global feed). */
  kind: 'terminal' | 'events';
}

const TICKET_TTL_MS = 10_000;
const tickets = new Map<string, Ticket>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [k, v] of tickets) {
    if (now - v.createdAt > TICKET_TTL_MS) tickets.delete(k);
  }
}

export function issueTicket(kind: 'terminal' | 'events', sessionId: string): string {
  purgeExpired();
  const id = crypto.randomUUID();
  tickets.set(id, { sessionId, createdAt: Date.now(), kind });
  return id;
}

/**
 * Consume a ticket (single-use). Returns the ticket if valid, else null.
 * Removes the ticket on success.
 */
export function consumeTicket(value: string, kind: 'terminal' | 'events'): Ticket | null {
  purgeExpired();
  const t = tickets.get(value);
  if (!t) return null;
  if (t.kind !== kind) return null;
  tickets.delete(value);
  if (Date.now() - t.createdAt > TICKET_TTL_MS) return null;
  return t;
}
