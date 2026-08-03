import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../../modules/db/index.js';
import { RoleStore } from '../../modules/roles/index.js';
import { SkillStore } from '../../modules/skills/store.js';
import { SkillInstaller } from '../../modules/skills/installer.js';
import { SkillsSubsystem, type SkillView } from '../../modules/skills/index.js';
import type { Config } from '../../config.js';
import { createSkillsRouter } from './skills.js';

let dir: string;
let db: SwarmDb;
let subsystem: SkillsSubsystem;
let listening: Server | null = null;
let base: string;
let srcDir: string;

function fakeConfig(): Config {
  return {
    dataDir: dir,
    workspaceRoot: path.join(dir, 'ws'),
    hostWorkspaceRoot: null,
    agentTransport: 'local',
  } as unknown as Config;
}

function writeSkill(target: string, body: string): void {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, 'SKILL.md'),
    `---\nname: hello-skill\nversion: 0.1.0\ndescription: A greeter.\n---\n${body}\n`,
    'utf8',
  );
}

async function start(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createSkillsRouter(subsystem));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-http-'));
  db = new SwarmDb(dir);
  const store = new SkillStore(db);
  // Offline market policy (no endpoint, no catalog) so market search is
  // deterministically `available:false` — these route tests never hit GitHub.
  const installer = new SkillInstaller({
    skillsDir: path.join(dir, 'skills'),
    store,
    market: { catalog: [], catalogPrefix: '', timeoutMs: 1000 },
  });
  const roleStore = new RoleStore(db);
  subsystem = new SkillsSubsystem({ store, installer, roleStore, config: fakeConfig() });
  srcDir = path.join(dir, 'src-skill');
  await start();
});
afterEach(async () => {
  if (listening) await new Promise<void>((resolve) => listening!.close(() => resolve()));
  listening = null;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('skills REST router', () => {
  it('GET /skills is empty initially', async () => {
    const res = await fetch(`${base}/skills`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: SkillView[] };
    expect(body.skills).toEqual([]);
  });

  it('installs from a dir, lists it, reads its body, then deletes it', async () => {
    writeSkill(srcDir, 'Say hello.');
    const inst = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'dir', dir: srcDir }),
    });
    expect(inst.status).toBe(200);
    const instBody = (await inst.json()) as { skill: SkillView };
    expect(instBody.skill.name).toBe('hello-skill');
    expect(instBody.skill.trust).toBe('local');

    const list = (await (await fetch(`${base}/skills`)).json()) as { skills: SkillView[] };
    expect(list.skills).toHaveLength(1);

    const one = await fetch(`${base}/skills/hello-skill`);
    expect(one.status).toBe(200);
    const oneBody = (await one.json()) as { skill: SkillView; body: string };
    expect(oneBody.body).toContain('Say hello.');

    const del = await fetch(`${base}/skills/hello-skill`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const after = (await (await fetch(`${base}/skills`)).json()) as { skills: SkillView[] };
    expect(after.skills).toEqual([]);
  });

  it('rejects an unknown install source with 400', async () => {
    const res = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a git source with a missing url, and a market source with a missing ref (400)', async () => {
    const git = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git' }),
    });
    expect(git.status).toBe(400);
    const market = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'market' }),
    });
    expect(market.status).toBe(400);
  });

  it('market search is unavailable (200) with no endpoint/catalog configured, and 400 without a query', async () => {
    const ok = await fetch(`${base}/skills/market/search?q=pdf`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { available: boolean; results: unknown[] };
    expect(body.available).toBe(false);
    expect(body.results).toEqual([]);

    const noQuery = await fetch(`${base}/skills/market/search`);
    expect(noQuery.status).toBe(400);
  });

  it('maps a missing SKILL.md to 422', async () => {
    fs.mkdirSync(srcDir, { recursive: true });
    const res = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'dir', dir: srcDir }),
    });
    expect(res.status).toBe(422);
  });

  it('404s an unknown skill on GET and on upgrade', async () => {
    expect((await fetch(`${base}/skills/ghost`)).status).toBe(404);
    expect((await fetch(`${base}/skills/ghost/upgrade`, { method: 'POST' })).status).toBe(404);
  });

  it('reports drift on re-import (upgrade)', async () => {
    writeSkill(srcDir, 'v1 body');
    await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'dir', dir: srcDir }),
    });
    writeSkill(srcDir, 'v2 body changed');
    const up = await fetch(`${base}/skills/hello-skill/upgrade`, { method: 'POST' });
    expect(up.status).toBe(200);
    const body = (await up.json()) as {
      skill: SkillView;
      drift: { checksumChanged: boolean; previousBody: string };
    };
    expect(body.drift.checksumChanged).toBe(true);
    expect(body.drift.previousBody).toContain('v1 body');
  });
});

function writeRiskySkill(target: string): void {
  fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(target, 'SKILL.md'),
    `---\nname: risky-skill\nversion: 0.1.0\ndescription: r.\nassets: { dir: assets }\n---\nBody.\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(target, 'assets', 'run.sh'), '#!/bin/sh\necho danger\n', { mode: 0o755 });
}

async function installRisky(): Promise<void> {
  writeRiskySkill(srcDir);
  await fetch(`${base}/skills/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'dir', dir: srcDir }),
  });
}

async function activate(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/skills/risky-skill/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('skills REST — review gate (Lot 3)', () => {
  it('blocks activating a risky skill with 409 REVIEW_REQUIRED', async () => {
    await installRisky();
    const res = await activate({ orchestratorId: 'orch1' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; review: { assets: Array<{ path: string }> } };
    expect(body.code).toBe('REVIEW_REQUIRED');
    expect(body.review.assets.map((a) => a.path)).toContain('run.sh');
  });

  it('activates a risky skill with reviewed:true (one-call consent)', async () => {
    await installRisky();
    const res = await activate({ orchestratorId: 'orch1', reviewed: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { persisted: boolean };
    expect(body.persisted).toBe(true);
  });

  it('POST /review then activate succeeds (two-step review)', async () => {
    await installRisky();
    const rev = await fetch(`${base}/skills/risky-skill/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewed: true }),
    });
    expect(rev.status).toBe(200);
    const res = await activate({ orchestratorId: 'orch1' });
    expect(res.status).toBe(200);
  });

  it('GET /review lists assets + review state; GET /asset returns content', async () => {
    await installRisky();
    const rev = (await (await fetch(`${base}/skills/risky-skill/review`)).json()) as {
      review: { reviewRequired: boolean; assets: Array<{ path: string; executable: boolean }> };
    };
    expect(rev.review.reviewRequired).toBe(true);
    expect(rev.review.assets.find((a) => a.path === 'run.sh')?.executable).toBe(true);

    const asset = (await (
      await fetch(`${base}/skills/risky-skill/asset?path=run.sh`)
    ).json()) as { asset: { content: string } };
    expect(asset.asset.content).toContain('echo danger');

    // Traversal is refused (404).
    expect((await fetch(`${base}/skills/risky-skill/asset?path=../SKILL.md`)).status).toBe(404);
  });
});

describe('skills REST — export + packs (Lot 5a)', () => {
  function writeNamedSkill(target: string, name: string, body: string): void {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'SKILL.md'),
      `---\nname: ${name}\nversion: 0.1.0\ndescription: d.\n---\n${body}\n`,
      'utf8',
    );
  }
  async function installDir(dirPath: string): Promise<void> {
    const res = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'dir', dir: dirPath }),
    });
    expect(res.status).toBe(200);
  }

  it('GET /skills/:name/export returns a gzip attachment that re-imports via upload', async () => {
    writeSkill(srcDir, 'exportable body'); // name: hello-skill
    await installDir(srcDir);

    const exp = await fetch(`${base}/skills/hello-skill/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type')).toContain('application/gzip');
    expect(exp.headers.get('content-disposition')).toContain('hello-skill.tgz');
    const buf = Buffer.from(await exp.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);

    // Round-trip: the exported bytes re-import cleanly through the upload route.
    const up = await fetch(`${base}/skills/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/gzip' },
      body: buf,
    });
    expect(up.status).toBe(200);
    const upBody = (await up.json()) as { skill: SkillView };
    expect(upBody.skill.name).toBe('hello-skill');
  });

  it('GET /skills/:name/export 404s an unknown skill', async () => {
    expect((await fetch(`${base}/skills/ghost/export`)).status).toBe(404);
  });

  it('POST /skills/pack/export packs valid skills (skipping unknowns) and installs them back', async () => {
    writeNamedSkill(path.join(dir, 'a'), 'alpha', 'alpha body');
    writeNamedSkill(path.join(dir, 'b'), 'beta', 'beta body');
    await installDir(path.join(dir, 'a'));
    await installDir(path.join(dir, 'b'));

    const exp = await fetch(`${base}/skills/pack/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names: ['alpha', 'beta', 'ghost'] }),
    });
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type')).toContain('application/gzip');
    expect(exp.headers.get('content-disposition')).toContain('skills-pack-2.tgz');
    expect(exp.headers.get('x-skills-pack-included')).toBe('alpha,beta');
    expect(exp.headers.get('x-skills-pack-skipped-count')).toBe('1');
    const buf = Buffer.from(await exp.arrayBuffer());

    const inst = await fetch(`${base}/skills/pack/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/gzip' },
      body: buf,
    });
    expect(inst.status).toBe(200);
    const body = (await inst.json()) as {
      installed: SkillView[];
      errors: Array<{ name: string; error: string }>;
    };
    expect(body.errors).toEqual([]);
    expect(body.installed.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('POST /skills/pack/export 400s on empty names and on all-unknown names', async () => {
    const empty = await fetch(`${base}/skills/pack/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names: [] }),
    });
    expect(empty.status).toBe(400);

    const unknown = await fetch(`${base}/skills/pack/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names: ['ghost', 'phantom'] }),
    });
    expect(unknown.status).toBe(400);
  });

  it('POST /skills/pack/install 415s an empty body and 422s a corrupt archive', async () => {
    const empty = await fetch(`${base}/skills/pack/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/gzip' },
      body: Buffer.alloc(0),
    });
    expect(empty.status).toBe(415);

    const corrupt = await fetch(`${base}/skills/pack/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/gzip' },
      body: Buffer.from('definitely not a gzip tarball'),
    });
    expect(corrupt.status).toBe(422);
  });
});
