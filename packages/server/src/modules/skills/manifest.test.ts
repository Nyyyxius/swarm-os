import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSkillMd, splitFrontmatter, SKILL_FILE, SKILL_JSON_FILE } from './manifest.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(content: string, file = SKILL_FILE): void {
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
}

describe('parseSkillMd', () => {
  it('parses a valid SKILL.md into frontmatter + body', () => {
    write(`---
name: hello-skill
version: 0.1.0
displayName: Hello
description: A friendly greeter.
triggers: [hello, greeting]
---
# Body
Say hello.
`);
    const skill = parseSkillMd(dir);
    expect(skill.name).toBe('hello-skill');
    expect(skill.version).toBe('0.1.0');
    expect(skill.frontmatter.displayName).toBe('Hello');
    expect(skill.frontmatter.description).toBe('A friendly greeter.');
    expect(skill.frontmatter.triggers).toEqual(['hello', 'greeting']);
    expect(skill.body).toContain('# Body');
    expect(skill.body).toContain('Say hello.');
    // Frontmatter must NOT leak into the body.
    expect(skill.body).not.toContain('name: hello-skill');
  });

  it('parses inline flow maps (requires / assets)', () => {
    write(`---
name: tooled-skill
version: 1.2.3
requires: { plugins: [novelai], capabilities: [] }
assets: { dir: assets }
---
body`);
    const skill = parseSkillMd(dir);
    expect(skill.frontmatter.requires?.plugins).toEqual(['novelai']);
    expect(skill.frontmatter.requires?.capabilities).toEqual([]);
    expect(skill.frontmatter.assets?.dir).toBe('assets');
  });

  it('lets SKILL.md frontmatter override the skill.json base', () => {
    write('{"name":"from-json","version":"9.9.9","description":"json base"}', SKILL_JSON_FILE);
    write(`---
name: from-md
version: 0.1.0
---
body`);
    const skill = parseSkillMd(dir);
    expect(skill.name).toBe('from-md');
    expect(skill.version).toBe('0.1.0');
    // A field only in skill.json still shows through.
    expect(skill.frontmatter.description).toBe('json base');
  });

  it('throws when SKILL.md is missing', () => {
    expect(() => parseSkillMd(dir)).toThrow(/not found/);
  });

  it('throws when name is missing', () => {
    write(`---
version: 0.1.0
---
body`);
    expect(() => parseSkillMd(dir)).toThrow(/name/);
  });

  it('throws for a malformed name', () => {
    write(`---
name: Hello_Skill
version: 0.1.0
---
body`);
    expect(() => parseSkillMd(dir)).toThrow(/name/);
  });

  it('throws for a reserved name', () => {
    write(`---
name: team
version: 0.1.0
---
body`);
    expect(() => parseSkillMd(dir)).toThrow(/reserved/);
  });

  it('throws when version is missing', () => {
    write(`---
name: no-version
---
body`);
    expect(() => parseSkillMd(dir)).toThrow(/version/);
  });

  it('rejects an assets.dir that escapes the skill folder', () => {
    write(`---
name: escaper
version: 0.1.0
assets: { dir: ../evil }
---
body`);
    expect(() => parseSkillMd(dir)).toThrow(/assets\.dir/);
  });
});

describe('splitFrontmatter', () => {
  it('returns empty frontmatter and the whole text as body when there is no block', () => {
    const { frontmatter, body } = splitFrontmatter('# just a body\nno frontmatter');
    expect(frontmatter).toBe('');
    expect(body).toContain('# just a body');
  });

  it('separates the fenced block from the body', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n---\nhello body\n');
    expect(frontmatter).toBe('name: x');
    expect(body).toBe('hello body\n');
  });
});
