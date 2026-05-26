import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readLogTail, buildResumeNotice } from './log-tail-reader.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logtail-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('readLogTail', () => {
  it('returns empty string for a missing file', () => {
    expect(readLogTail(path.join(tmp, 'nope.log'))).toBe('');
  });

  it('returns the whole file when smaller than maxBytes', () => {
    const p = path.join(tmp, 'small.log');
    fs.writeFileSync(p, 'line one\nline two\nline three\n');
    const out = readLogTail(p);
    expect(out).toContain('line one');
    expect(out).toContain('line three');
  });

  it('returns only the trailing maxBytes for a large file', () => {
    const p = path.join(tmp, 'big.log');
    const big = 'X'.repeat(20_000) + '\nfinal-marker\n';
    fs.writeFileSync(p, big);
    const out = readLogTail(p, { maxBytes: 100 });
    expect(out).toContain('final-marker');
    expect(out.length).toBeLessThan(200);
  });

  it('strips ANSI escape sequences', () => {
    const p = path.join(tmp, 'ansi.log');
    // CSI color + cursor moves + OSC title set
    fs.writeFileSync(
      p,
      '\x1b[31mred text\x1b[0m\n\x1b[2J\x1b[H\x1b]0;title\x07normal\n',
    );
    const out = readLogTail(p);
    expect(out).toContain('red text');
    expect(out).toContain('normal');
    // No raw escape bytes leak through.
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
  });

  it('caps at maxLines and drops empty lines', () => {
    const p = path.join(tmp, 'many.log');
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n\n');
    fs.writeFileSync(p, lines);
    const out = readLogTail(p, { maxLines: 5 });
    const split = out.split('\n');
    expect(split.length).toBeLessThanOrEqual(5);
    expect(split[split.length - 1]).toBe('line-99');
  });
});

describe('buildResumeNotice', () => {
  it('embeds the log tail and the defensive header', () => {
    const p = path.join(tmp, 'session.log');
    fs.writeFileSync(p, 'tool=Bash cmd=git status\nworking on refactor\n');
    const notice = buildResumeNotice(p);
    expect(notice).toContain('Server restart notice');
    expect(notice).toContain('git status');
    expect(notice).toContain('previous_session_tail');
    expect(notice).toContain('Do NOT assume your prior work succeeded');
  });

  it('uses an explicit empty marker when log is missing', () => {
    const notice = buildResumeNotice(path.join(tmp, 'never-existed.log'));
    expect(notice).toContain('(empty — no prior log available)');
  });

  it('returns notice text even when given null path', () => {
    const notice = buildResumeNotice(null);
    expect(notice).toContain('Server restart notice');
    expect(notice).toContain('(empty');
  });
});
