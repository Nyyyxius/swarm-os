import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readConsoleTail,
  renderPtyLines,
  condenseLines,
  CONSOLE_TAIL_LINES,
} from './console-tail.js';

const ESC = '\x1B';
/** Strip SGR so assertions can talk about text without escape noise. */
// eslint-disable-next-line no-control-regex -- ESC is the subject matter here
const plain = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'consoletail-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('renderPtyLines — cursor motion is resolved, not deleted', () => {
  it('expands absolute column jumps (CHA) into real spacing', () => {
    // This is how the Ink TUI actually lays out a line: it never emits the
    // spaces between words, it jumps to the column. Deleting the jumps would
    // yield "bypasspermissionson".
    const raw = `${ESC}[6Gbypass${ESC}[13Gpermissions${ESC}[25Gon\n`;
    const [line] = renderPtyLines(raw, 100);
    expect(plain(line)).toBe('     bypass permissions on');
  });

  it('honours HPA (ESC[n`) the same way as CHA', () => {
    const raw = `a${ESC}[10\`b\n`;
    const [line] = renderPtyLines(raw, 100);
    expect(plain(line)).toBe('a        b');
  });

  it('expands relative cursor-forward and applies cursor-back', () => {
    const forward = renderPtyLines(`ab${ESC}[3Ccd\n`, 100)[0];
    expect(plain(forward)).toBe('ab   cd');
    // Back up two columns and overwrite what was there.
    const back = renderPtyLines(`abcd${ESC}[2DXY\n`, 100)[0];
    expect(plain(back)).toBe('abXY');
  });

  it('treats a lone CR as a return to column 0, overwriting in place', () => {
    const [line] = renderPtyLines(`hello\rHE\n`, 100);
    expect(plain(line)).toBe('HEllo');
  });

  it('keeps text that precedes a trailing CR', () => {
    // Regression: taking the segment AFTER the last CR discards the line
    // entirely, since PTY lines routinely end with CR before the newline.
    const [line] = renderPtyLines(`important output\r\n`, 100);
    expect(plain(line)).toBe('important output');
  });

  it('applies erase-to-end-of-line (ESC[K)', () => {
    const [line] = renderPtyLines(`abcdef${ESC}[3G${ESC}[K\n`, 100);
    expect(plain(line)).toBe('ab');
  });

  it('clears the whole line on ESC[2K', () => {
    const [line] = renderPtyLines(`garbage${ESC}[2Gkept\n`, 100);
    expect(plain(line)).toContain('kept');
    const [cleared] = renderPtyLines(`garbage${ESC}[2K${ESC}[1Gfresh\n`, 100);
    expect(plain(cleared)).toBe('fresh');
  });
});

describe('renderPtyLines — colour survives', () => {
  it('preserves SGR sequences verbatim', () => {
    const raw = `${ESC}[38;5;211mpink${ESC}[39m\n`;
    const [line] = renderPtyLines(raw, 100);
    expect(line).toContain(`${ESC}[38;5;211m`);
    expect(line).toContain(`${ESC}[39m`);
    expect(plain(line)).toBe('pink');
  });

  it('does not let the C0 cleanup eat the ESC that introduces SGR', () => {
    // Regression: a C0 strip of \x0E-\x1F includes \x1B, which silently
    // removes every escape introducer and drops all colour.
    const raw = `${ESC}[31mred\n`;
    const [line] = renderPtyLines(raw, 100);
    expect(line.includes(ESC)).toBe(true);
  });

  it('drops motion and mode sequences but not colour', () => {
    const raw = `${ESC}[?25l${ESC}[4A${ESC}[32mgreen${ESC}[0m${ESC}[2J\n`;
    const [line] = renderPtyLines(raw, 100);
    expect(plain(line)).toBe('green');
    expect(line).toContain(`${ESC}[32m`);
    expect(line).not.toContain('?25l');
  });

  it('strips OSC sequences entirely', () => {
    const raw = `${ESC}]0;window title\x07visible\n`;
    const [line] = renderPtyLines(raw, 100);
    expect(plain(line)).toBe('visible');
    expect(line).not.toContain('window title');
  });
});

describe('condenseLines', () => {
  it('collapses a repaint duplicate seen within the window', () => {
    const lines = ['status bar', 'work A', 'status bar', 'work B'];
    const out = condenseLines(lines, 100);
    expect(out).toEqual(['status bar', 'work A', 'work B']);
  });

  it('keeps a repeat that falls outside the dedupe window', () => {
    // 40-line window: a repeat 60 lines later is genuine content, not chrome.
    const lines = ['marker', ...Array.from({ length: 60 }, (_, i) => `line ${i}`), 'marker'];
    const out = condenseLines(lines, 500);
    expect(out.filter((l) => l === 'marker')).toHaveLength(2);
  });

  it('ignores colour when comparing duplicates', () => {
    const lines = [`${ESC}[31msame${ESC}[0m`, `${ESC}[32msame${ESC}[0m`];
    expect(condenseLines(lines, 100)).toHaveLength(1);
  });

  it('collapses runs of blank lines to a single separator', () => {
    const out = condenseLines(['a', '', '', '', 'b'], 100);
    expect(out).toEqual(['a', '', 'b']);
  });

  it('caps at maxLines, keeping the most recent', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const out = condenseLines(lines, 10);
    expect(out).toHaveLength(10);
    expect(out[out.length - 1]).toBe('line 499');
  });
});

describe('readConsoleTail', () => {
  it('returns [] for a missing file', () => {
    expect(readConsoleTail(path.join(tmp, 'nope.log'))).toEqual([]);
  });

  it('returns [] for an empty file', () => {
    const p = path.join(tmp, 'empty.log');
    fs.writeFileSync(p, '');
    expect(readConsoleTail(p)).toEqual([]);
  });

  it('renders a small log in full', () => {
    const p = path.join(tmp, 'small.log');
    fs.writeFileSync(p, `${ESC}[32mfirst${ESC}[0m\r\nsecond\r\n`);
    const out = readConsoleTail(p);
    expect(out.map(plain)).toEqual(['first', 'second']);
  });

  it('reads far deeper than the 200-line in-memory ring buffer', () => {
    const p = path.join(tmp, 'deep.log');
    const body = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\r\n');
    fs.writeFileSync(p, `${body}\r\n`);
    const out = readConsoleTail(p);
    expect(out.length).toBeGreaterThan(500);
    expect(plain(out[out.length - 1])).toBe('line 899');
  });

  it('caps the result at maxLines', () => {
    const p = path.join(tmp, 'huge.log');
    const body = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\r\n');
    fs.writeFileSync(p, `${body}\r\n`);
    const out = readConsoleTail(p);
    expect(out.length).toBeLessThanOrEqual(CONSOLE_TAIL_LINES);
    // Still anchored to the END of the log — that is the point of a tail.
    expect(plain(out[out.length - 1])).toBe('line 3999');
  });

  it('drops the first, probably-truncated line when the window cuts mid-file', () => {
    const p = path.join(tmp, 'cut.log');
    fs.writeFileSync(p, `AAAAAAAAAA\r\nBBBBBBBBBB\r\nCCCCCCCCCC\r\n`);
    const out = readConsoleTail(p, { maxBytes: 25 });
    expect(out.some((l) => plain(l) === 'CCCCCCCCCC')).toBe(true);
    expect(out.some((l) => plain(l) === 'AAAAAAAAAA')).toBe(false);
  });

  it('survives a multi-byte character split by the byte window', () => {
    const p = path.join(tmp, 'utf8.log');
    fs.writeFileSync(p, `${'é'.repeat(50)}\r\nrépare postgres\r\n`);
    const out = readConsoleTail(p, { maxBytes: 30 });
    expect(out.some((l) => plain(l).includes('répare postgres'))).toBe(true);
  });
});
