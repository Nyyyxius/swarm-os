import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Request, Response } from 'express';
import { SwarmDb } from '../modules/db/index.js';
import { SwarmEventBus } from '../events.js';
import { FeatureRegistry } from '../modules/features/registry.js';
import { featureGate } from './feature-gate.js';

let dir: string;
let db: SwarmDb;
let features: FeatureRegistry;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-gate-'));
  db = new SwarmDb(dir);
  features = new FeatureRegistry({
    db,
    eventBus: new SwarmEventBus(),
    config: { codegraphEnabled: true, ideEnabled: true },
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function mockRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _body: unknown };
}

describe('featureGate', () => {
  it('calls next() when the feature is enabled', () => {
    const next = vi.fn();
    const res = mockRes();
    featureGate(features, 'memory')({} as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(0);
  });

  it('answers 404 FEATURE_DISABLED when the feature is disabled', async () => {
    await features.disable('memory');
    const next = vi.fn();
    const res = mockRes();
    featureGate(features, 'memory')({} as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'FEATURE_DISABLED', feature: 'memory' });
  });
});
