import * as fs from 'node:fs';
import { withModule } from '../../logger.js';

const log = withModule('log-tail-reader');

/**
 * Phase 8 — read the tail of a session's PTY log so we can inject it into
 * the resume notice. The agent then has actual context from its previous
 * incarnation (what it was doing, last tool calls, last user input) rather
 * than just "your files exist, figure it out".
 *
 * Strategy:
 *   1. Open the log file, seek to `max(0, size - maxBytes)`.
 *   2. Read the remaining bytes synchronously (small, bounded).
 *   3. Strip ANSI / VT100 escape codes — the PTY log is raw, full of
 *      cursor moves, colour codes, terminal title sets, etc.
 *   4. Drop empty / control-only lines and cap at `maxLines` from the end.
 *
 * Returns an empty string if the file is missing or unreadable. Callers
 * should fall back gracefully (the notice text already covers this).
 */
export function readLogTail(
  logPath: string,
  opts: { maxBytes?: number; maxLines?: number } = {},
): string {
  const maxBytes = opts.maxBytes ?? 8192;
  const maxLines = opts.maxLines ?? 50;
  let fd: number | null = null;
  try {
    const stat = fs.statSync(logPath);
    fd = fs.openSync(logPath, 'r');
    const size = stat.size;
    const readSize = Math.min(size, maxBytes);
    const offset = Math.max(0, size - readSize);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, offset);
    const raw = buf.toString('utf8');
    const stripped = stripAnsi(raw);
    // Drop trailing empty lines and keep the last `maxLines` non-empty ones.
    const lines = stripped.split('\n');
    const meaningful = lines.filter((l) => l.trim().length > 0);
    const tail = meaningful.slice(-maxLines).join('\n');
    return tail;
  } catch (err) {
    // ENOENT for fresh sessions that never wrote a log is expected — don't
    // log warn-level for the common case. Other errors are surprising.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn({
        event: 'log_tail.read_failed',
        logPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return '';
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

/**
 * Strip the most common ANSI escape sequences a PTY log accumulates:
 *  - CSI sequences  (ESC [ ... letter)         — colour, cursor moves
 *  - OSC sequences  (ESC ] ... BEL or ESC \)   — title sets, hyperlinks
 *  - Single-char ESC codes (ESC = , ESC c, etc.)
 *  - Other C0 control chars except \n, \r, \t
 */
function stripAnsi(s: string): string {
  // CSI / OSC / ESC followed by various terminators.
  const ansi =
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-_])/g;
  let out = s.replace(ansi, '');
  // Strip leftover C0 controls except CR/LF/TAB. Keep \n so .split('\n') works.
  out = out.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  return out;
}

/**
 * Format the full "## Server restart notice" block, with the log tail
 * injected. Kept as a pure function so tests can assert the exact string
 * shape without spinning a Session.
 */
export function buildResumeNotice(logPath: string | null): string {
  const tail = logPath ? readLogTail(logPath) : '';
  const tailBlock = tail
    ? `<previous_session_tail>\n${tail}\n</previous_session_tail>`
    : `<previous_session_tail>(empty — no prior log available)</previous_session_tail>`;

  return `---

## Server restart notice

The previous session was interrupted by a server restart. Your chat
context above is gone, but your workspace at the cwd above may or may
not be in a coherent state — the prior PTY died at an arbitrary point.

Before continuing the task:
1. Run \`git status\` and \`git diff\` to inspect uncommitted changes.
2. Review the files you were last editing for partial writes.
3. Decide whether to redo, resume, or roll back recent changes.

Do NOT assume your prior work succeeded.

Below is a tail of your previous session's PTY log (last ~50 meaningful
lines) so you can re-establish context:

${tailBlock}

If the log tail is empty or shows nothing useful, fall back to
re-reading the user's original instructions (above) and resume from
there. Check your inbox via \`team.read_inbox\` for any messages that
arrived during the outage.`;
}
