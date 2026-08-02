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
  const installer = new SkillInstaller({ skillsDir: path.join(dir, 'skills'), store });
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

  it('rejects an unsupported install source with 400', async () => {
    const res = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git', url: 'x' }),
    });
    expect(res.status).toBe(400);
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
});
