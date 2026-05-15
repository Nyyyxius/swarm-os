import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'node:crypto';

const HEADER = 'x-auth-token';

/** Constant-time string comparison to avoid timing leaks. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function makeAuthMiddleware(token: string) {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    const provided = req.header(HEADER);
    if (!provided || !safeEqual(provided, token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
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
