import * as fs from 'node:fs';
import { withModule } from '../../logger.js';

const log = withModule('console-tail');

/**
 * Console replay history — the deep scrollback a client gets when it attaches
 * to a session's terminal WebSocket.
 *
 * This is the mirror image of `readLogTail` (log-tail-reader.ts). That one
 * feeds a *prompt*, so it strips every escape sequence. This one feeds an
 * *xterm*, so it must keep the colour and, crucially, RESOLVE the cursor
 * motion instead of deleting it.
 *
 * Deleting it is not an option, and that is the whole reason this module is a
 * renderer rather than a regex. Measured on a real 21 MB claude session log,
 * the Ink TUI lays out its lines with absolute column jumps and never with
 * literal spaces:
 *
 *     ESC[3G ESC[38;5;211m ⏵⏵ ESC[6G bypass ESC[13G permissions ESC[25G on
 *
 * Strip the `G` sequences and you get `bypasspermissionson`. So each line is
 * replayed through a one-line terminal emulator: a sparse cell array plus a
 * cursor column. Absolute jumps land in the right cell and the gaps render as
 * spaces.
 *
 * What is deliberately NOT emulated is vertical motion (`A`/`B`/`H`/`J`). The
 * whole point is to linearise: the PTY log is a scroll of repaints, and a
 * client attaching mid-session has no screen state to repaint onto. Dropping
 * vertical motion turns "repaint frame in place" into "append frame", which
 * is what a scrollback should look like. `dedupeWindow` then removes the
 * duplicate frames that linearisation necessarily creates (see below).
 */

/** Default replay depth, in rendered lines. */
export const CONSOLE_TAIL_LINES = 1000;

/**
 * How many trailing bytes to scan to find those lines. Escape sequences are
 * the bulk of a PTY log — measured at ~61% on real claude sessions — so the
 * byte window has to be far larger than the line budget suggests. 512 KB
 * yielded ~2.2k rendered lines on the densest log on disk, comfortably above
 * CONSOLE_TAIL_LINES.
 */
const CONSOLE_TAIL_BYTES = 512 * 1024;

/**
 * Widest column an absolute jump may address. Guards against a corrupt
 * `ESC[999999G` allocating a huge row. Wider than any real terminal.
 */
const MAX_COLS = 400;

/**
 * Sliding window, in lines, for duplicate suppression.
 *
 * A repainting TUI overwrites its previous frame IN PLACE, so the operator
 * saw the status bar and box borders once — not once per repaint. Linearising
 * would therefore *invent* duplicates that never appeared on screen.
 * Collapsing a line that already occurred within roughly one screen height
 * restores what was actually visible. Beyond that distance a repeat is
 * treated as genuine content and kept.
 */
const DEDUPE_WINDOW = 40;

export interface ConsoleTailOptions {
  maxLines?: number;
  maxBytes?: number;
}

/** Strip SGR so two differently-coloured renderings of one line compare equal. */
function dedupeKey(line: string): string {
  // eslint-disable-next-line no-control-regex -- ESC is the subject matter here
  return line.replace(/\x1B\[[0-9;]*m/g, '').trim();
}

/**
 * Replay raw PTY bytes as a list of linear, colour-preserving lines.
 *
 * Exported for tests — `readConsoleTail` is the file-backed entry point.
 */
export function renderPtyLines(raw: string, maxLines: number): string[] {
  const out: string[] = [];
  // Sparse: index = column, value = the text emitted for that cell (a single
  // character, possibly prefixed by the SGR sequences that preceded it).
  let cells: string[] = [];
  let col = 0;
  // SGR seen but not yet attached to a cell. Escapes are zero-width, so they
  // ride along with the next character rather than occupying a column.
  let pending = '';

  const flush = (): void => {
    let line = '';
    for (let i = 0; i < cells.length; i++) line += cells[i] ?? ' ';
    // Trailing padding is an artifact of the cell array, never real content.
    line = line.replace(/[ \t]+$/, '');
    // Keep a trailing reset so colour never bleeds into the next line.
    line += pending;
    out.push(line);
    // Bound memory on multi-MB scans: keep a generous multiple of the budget
    // so the dedupe pass downstream still has material to work with.
    if (out.length > maxLines * 4) out.splice(0, out.length - maxLines * 4);
    cells = [];
    col = 0;
    pending = '';
  };

  const applyCsi = (params: string, final: string): void => {
    const parsed = parseInt(params, 10);
    const arg = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    switch (final) {
      case 'm':
        // The one sequence we keep verbatim: colour and text attributes.
        pending += `\x1B[${params}m`;
        break;
      case 'G':
      case '`':
        // CHA / HPA — absolute column. The TUI's primary layout mechanism.
        col = Math.max(0, Math.min(MAX_COLS, arg - 1));
        break;
      case 'C':
        col = Math.min(MAX_COLS, col + arg);
        break;
      case 'D':
        col = Math.max(0, col - arg);
        break;
      case 'K': {
        const mode = params === '' ? 0 : parsed || 0;
        if (mode === 0) {
          if (cells.length > col) cells.length = col;
        } else if (mode === 1) {
          for (let k = 0; k <= col && k < cells.length; k++) cells[k] = ' ';
        } else {
          cells = [];
        }
        break;
      }
      default:
        // Vertical motion, erase-in-display, mode sets, everything else:
        // intentionally dropped. See the module header.
        break;
    }
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === undefined) break;
    if (ch === '\x1B') {
      const next = raw[i + 1];
      if (next === ']') {
        // OSC — window title, hyperlinks. Runs to BEL or ST.
        let j = i + 2;
        while (j < raw.length && raw[j] !== '\x07' && raw[j] !== '\x1B') j++;
        i = raw[j] === '\x1B' ? j + 2 : j + 1;
        continue;
      }
      if (next === '[') {
        let j = i + 2;
        const inRange = (at: number, lo: string, hi: string): boolean => {
          const c = raw[at];
          return c !== undefined && c >= lo && c <= hi;
        };
        while (j < raw.length && inRange(j, '\x30', '\x3F')) j++;
        const params = raw.slice(i + 2, j);
        while (j < raw.length && inRange(j, '\x20', '\x2F')) j++;
        const final = raw[j];
        i = j + 1;
        if (final !== undefined) applyCsi(params, final);
        continue;
      }
      // Two-byte ESC form (ESC 7, ESC =, ESC c, …) — no visible effect here.
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      i++;
      continue;
    }
    if (ch === '\r') {
      // Carriage return alone: back to column 0, content so far survives.
      col = 0;
      i++;
      continue;
    }
    if (ch === '\t') {
      col = Math.min(MAX_COLS, (Math.floor(col / 8) + 1) * 8);
      i++;
      continue;
    }
    if (ch < ' ' || ch === '\x7F') {
      i++;
      continue;
    }
    if (col < MAX_COLS) {
      cells[col] = pending + ch;
      pending = '';
    }
    col++;
    i++;
  }
  // Trailing partial line (no final newline) — the session's current state.
  if (cells.length > 0 || pending !== '') flush();

  return out;
}

/**
 * Collapse blank runs and near-duplicate repaint lines, then keep the last
 * `maxLines`. Exported for tests.
 */
export function condenseLines(lines: string[], maxLines: number): string[] {
  const kept: string[] = [];
  const recent: string[] = [];
  let lastWasBlank = false;
  for (const line of lines) {
    const key = dedupeKey(line);
    if (key === '') {
      // Collapse runs of blank lines to a single separator.
      if (lastWasBlank) continue;
      lastWasBlank = true;
      kept.push('');
      continue;
    }
    lastWasBlank = false;
    if (recent.includes(key)) continue;
    kept.push(line);
    recent.push(key);
    if (recent.length > DEDUPE_WINDOW) recent.shift();
  }
  // Leading blank after truncation is noise.
  const tail = kept.slice(-maxLines);
  while (tail.length > 0 && tail[0] === '') tail.shift();
  return tail;
}

/**
 * Read the tail of a session's PTY log and render it as replayable console
 * lines. Returns `[]` when the log is missing, empty, or unreadable — callers
 * fall back to the in-memory ring buffer.
 */
export function readConsoleTail(
  logPath: string,
  opts: ConsoleTailOptions = {},
): string[] {
  const maxLines = opts.maxLines ?? CONSOLE_TAIL_LINES;
  const maxBytes = opts.maxBytes ?? CONSOLE_TAIL_BYTES;
  let fd: number | null = null;
  try {
    const stat = fs.statSync(logPath);
    if (stat.size === 0) return [];
    fd = fs.openSync(logPath, 'r');
    const readSize = Math.min(stat.size, maxBytes);
    const offset = Math.max(0, stat.size - readSize);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, offset);
    const raw = buf.toString('utf8');
    const lines = renderPtyLines(raw, maxLines);
    // A mid-file offset almost always cuts the first line (and possibly a
    // multi-byte character) in half — drop it rather than show a fragment.
    if (offset > 0 && lines.length > 0) lines.shift();
    return condenseLines(lines, maxLines);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn({
        event: 'console_tail.read_failed',
        logPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}
