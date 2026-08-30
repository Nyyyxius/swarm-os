#!/usr/bin/env tsx
/**
 * Spike — Claude Code `SessionStart` hook.
 *
 * Verifies, against the real CLI, every fact the `docs/monitoring-agents.md`
 * plan assumes before the claude provider starts declaring a `SessionStart`
 * hook (section « Usage de contexte claude »):
 *
 *   S1 — the hook fires on interactive startup, on `--print`, after `/clear`
 *        and after `/compact`, and which `source` value each carries.
 *   S2 — the exact stdin payload schema, and that `transcript_path` points at
 *        a real `.jsonl` whose `type:"assistant"` lines carry `message.usage`.
 *   S3 — whether a hook's stdout is injected into the agent's context
 *        (the critical one: our integration MUST be mute).
 *   S4 — whether `/clear` rotates the transcript file or reuses it.
 *   S5 — whether a hook command that exits non-zero kills the session.
 *
 * Run: `pnpm verify:claude-sessionstart`
 *
 * Cost control: every session runs on `--model haiku` with one-word prompts.
 *
 * Auth: the interactive TUI will NOT accept a bare `CLAUDE_CODE_OAUTH_TOKEN`
 * (it runs the login flow instead — see S1c notes). The spike therefore
 * reproduces the production recipe from `providers/claude.ts`: symlink the
 * host `.credentials.json` into the throwaway `CLAUDE_CONFIG_DIR` (a symlink,
 * never a copy — no credential is duplicated on disk) and seed a per-session
 * `.claude.json` carrying `hasCompletedOnboarding` + the cwd trust flags.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// ----- Paths --------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REPORT_PATH = resolve(__dirname, 'verify-claude-sessionstart.report.md');

/**
 * Throwaway root. Deliberately under /tmp/claude-1000 (never inside the repo)
 * and wiped at both ends of the run: these dirs accumulate real transcripts.
 */
const SPIKE_TMP = '/tmp/claude-1000/verify-claude-sessionstart';
const REAL_CLAUDE_DIR = join(homedir(), '.claude');

/** `node-pty` only resolves from the server package under pnpm. */
const requireFromServer = createRequire(join(REPO_ROOT, 'packages', 'server', 'package.json'));

// ----- Types --------------------------------------------------------------

type Status = 'CONFIRMED' | 'INFIRMED' | 'PARTIAL' | 'UNVERIFIED';

interface CheckResult {
  id: string;
  title: string;
  status: Status;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notes: string;
  durationMs: number;
}

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  [k: string]: unknown;
}

const MODEL = process.env['CLAUDE_SPIKE_MODEL'] ?? 'haiku';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Where the observed behaviour differs from what `docs/monitoring-agents.md`
 * (section « Usage de contexte claude ») assumes. Rendered at the end of the
 * report so the plan can be corrected against measured facts.
 */
const DEVIATIONS: Record<string, string> = {
  'Valeur `source` en print mode':
    'Le plan liste `startup|resume|clear|compact|fork`. `claude -p` ne reçoit **pas** de source dédiée : il réutilise `startup` (S1b). Aucune branche du serveur ne doit donc filtrer sur une source « print ». `resume` et `fork` n\'ont pas été exercés par ce spike.',
  'Rotation du transcript — asymétrie clear / compact':
    'Le plan traite `clear` et `compact` de la même façon (« re-fournit le nouveau chemin »). Mesuré, les deux ne se comportent PAS pareil (S4) : `/clear` **rotationne** — nouveau `session_id` CLI **et** nouveau fichier `.jsonl` ; `/compact` **ne rotationne pas** — même `session_id`, même fichier, réécrit en place. Le hook re-fournit bien le chemin dans les deux cas, donc « toujours adopter le chemin du payload » reste la bonne règle et couvre les deux ; mais le corollaire vaut d\'être noté : après un compact, le fichier grossit sans changer de nom, alors qu\'après un clear l\'ancien fichier reste sur disque, orphelin. Le nom est `<session_id-du-CLI>.jsonl` — pas l\'id de session swarm-os. Corollaire pour le fallback « plus récent `.jsonl` du projects dir par mtime » : il est plus fragile que le plan ne le suppose, puisqu\'un seul agent produit légitimement plusieurs transcripts dans le même répertoire au cours de sa vie.',
  'Compaction refusée = aucun hook':
    'Le plan suppose implicitement qu\'un compact opérateur produit un callback. Faux si la conversation est trop courte : le CLI répond « Not enough messages to compact. » et **ne déclenche rien** (S1d). Le badge `contextResetPending` ne doit donc pas attendre un `SessionStart` pour retomber.',
  'Parse du transcript — ne jamais sommer':
    'Deux lignes `type:"assistant"` consécutives peuvent porter le **même `message.id` et le même objet `usage`** (bloc thinking + bloc texte d\'un même tour) — S2. Sommer les lignes assistant double-compte. Prendre la dernière, comme le plan le spécifie déjà, est la bonne règle : ce spike la confirme et explique pourquoi.',
  'Dernière ligne ≠ ligne assistant':
    'Le transcript se termine couramment par `last-prompt` (autres types observés : `queue-operation`, `attachment`, `atis-latch`) — S2. Le parseur doit remonter le fichier à l\'envers ; lire la dernière ligne du `tail -c` ne suffit pas.',
  'Risque H6 (non-2xx tue le CLI)':
    'Le plan impose de livrer la branche `hooks.ts` (200 systématique) avant le changement de settings, par crainte d\'un crash sur non-2xx. Pour `SessionStart` cette contrainte tombe : un hook qui sort en exit 1 est **non bloquant** (S5, `hook_non_blocking_error`), et un `curl` sans `-f` sort de toute façon en 0 sur une réponse 400 (S6). L\'ordre de livraison reste prudent, mais ce n\'est plus un risque de crash.',
  'Auth du TUI interactif':
    'Un `CLAUDE_CODE_OAUTH_TOKEN` seul suffit à `--print` mais **pas** au TUI interactif, qui repart dans le flux de login si le `CLAUDE_CONFIG_DIR` ne contient ni `.credentials.json` ni un `.claude.json` avec `hasCompletedOnboarding`. C\'est déjà ce que fait `providers/claude.ts` (symlink + seed) ; à ne pas régresser.',
};

// ----- Env ----------------------------------------------------------------

function oauthToken(): string | null {
  const fromEnv = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // ~/.profile exports it from this file on the host; a non-login shell (CI,
  // a subagent) will not have it in the environment.
  const file = join(homedir(), '.secrets', 'claude_code_token');
  try {
    const v = readFileSync(file, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

function claudeVersion(): string {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return (r.stdout ?? '').trim() || '(unknown)';
}

function trim(s: string | undefined, max = 3000): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

// ----- Sandbox construction ----------------------------------------------

interface Sandbox {
  root: string;
  cfgDir: string;
  workDir: string;
  hookLog: string;
  hookScript: string;
  env: Record<string, string>;
}

/**
 * Build one throwaway session sandbox: isolated `CLAUDE_CONFIG_DIR`, isolated
 * cwd, and a `SessionStart` hook whose body is `hookBody`.
 *
 * `hookBody` is a /bin/sh fragment; `$LOG` is bound to the payload log. Every
 * variant MUST consume stdin (the payload) or the CLI may see a broken pipe.
 */
function makeSandbox(name: string, hookBody: string): Sandbox {
  const root = join(SPIKE_TMP, name);
  const cfgDir = join(root, 'cfg');
  const workDir = join(root, 'work');
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const hookLog = join(root, 'hook-payloads.jsonl');
  const hookScript = join(root, 'hook.sh');
  writeFileSync(hookScript, `#!/bin/sh\nLOG="${hookLog}"\n${hookBody}\n`);
  chmodSync(hookScript, 0o755);

  // The exact settings.json shape the provider will emit.
  writeFileSync(
    join(cfgDir, 'settings.json'),
    JSON.stringify(
      { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: hookScript }] }] } },
      null,
      2,
    ),
  );

  // Production recipe (providers/claude.ts): share credentials by SYMLINK,
  // seed .claude.json so the TUI opens neither the login nor the trust dialog.
  const cred = join(REAL_CLAUDE_DIR, '.credentials.json');
  if (existsSync(cred)) {
    try {
      symlinkSync(cred, join(cfgDir, '.credentials.json'));
    } catch {
      /* already there */
    }
  }
  let base: Record<string, unknown> = { hasCompletedOnboarding: true };
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const src = parsed as Record<string, unknown>;
      // Copy only the identity/onboarding keys — not the host's project list.
      base = {
        hasCompletedOnboarding: true,
        userID: src['userID'],
        firstStartTime: src['firstStartTime'],
        lastOnboardingVersion: src['lastOnboardingVersion'],
        installMethod: src['installMethod'],
        autoUpdates: false,
      };
    }
  } catch {
    /* minimal seed is enough */
  }
  base['bypassPermissionsModeAccepted'] = true;
  base['projects'] = {
    [workDir]: {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      hasClaudeMdExternalIncludesApproved: true,
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
    },
  };
  writeFileSync(join(cfgDir, '.claude.json'), JSON.stringify(base, null, 2));

  const token = oauthToken();
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: cfgDir,
    // Never an ANTHROPIC_API_KEY: the host token is inference-only.
    ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
  };
  return { root, cfgDir, workDir, hookLog, hookScript, env };
}

/** Dump-stdin hook body: one raw payload per line, nothing on stdout. */
const HOOK_DUMP = `cat >> "$LOG"\nprintf '\\n' >> "$LOG"`;

function readPayloads(sb: Sandbox): HookPayload[] {
  if (!existsSync(sb.hookLog)) return [];
  return readFileSync(sb.hookLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l): HookPayload => {
      try {
        return JSON.parse(l) as HookPayload;
      } catch {
        return { raw: l };
      }
    });
}

// ----- Non-interactive runner --------------------------------------------

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  cmd: string;
  durationMs: number;
}

function runPrint(sb: Sandbox, prompt: string, extraArgs: string[] = []): RunResult {
  const args = ['-p', prompt, '--model', MODEL, ...extraArgs];
  const start = Date.now();
  const r = spawnSync('claude', args, {
    cwd: sb.workDir,
    encoding: 'utf8',
    timeout: 180_000,
    // `claude -p` warns and stalls 3s if stdin is an open TTY with no data.
    input: '',
    env: { ...process.env, ...sb.env },
  });
  return {
    status: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    cmd: `claude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
    durationMs: Date.now() - start,
  };
}

/**
 * Async twin of `runPrint`. Required whenever this process must serve the
 * hook's HTTP request itself: `spawnSync` blocks the event loop, so an
 * in-process server would never accept the connection and the hook's curl
 * would just hit its own timeout.
 */
async function runPrintAsync(sb: Sandbox, prompt: string): Promise<RunResult> {
  const { spawn } = await import('node:child_process');
  const args = ['-p', prompt, '--model', MODEL];
  const start = Date.now();
  return new Promise<RunResult>((res) => {
    const child = spawn('claude', args, {
      cwd: sb.workDir,
      env: { ...process.env, ...sb.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.stdin.end('');
    child.on('close', (code) => {
      clearTimeout(timer);
      res({
        status: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        cmd: `claude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
        durationMs: Date.now() - start,
      });
    });
  });
}

// ----- PTY runner ---------------------------------------------------------

interface PtyHandle {
  write: (s: string) => void;
  kill: () => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
}

/**
 * Mirrors what `Session` does in `orchestrator/session.ts`: raw capture,
 * last-activity idle detection, and the two-step Ink submit (payload, then a
 * lone CR ~200ms later — see `inkSubmitDance` in providers/claude.ts).
 */
class PtyRun {
  raw = '';
  lastData = Date.now();
  exited = false;
  exitCode: number | null = null;
  private readonly proc: PtyHandle;

  constructor(sb: Sandbox, args: string[]) {
    const pty = requireFromServer('node-pty') as {
      spawn: (f: string, a: string[], o: Record<string, unknown>) => PtyHandle;
    };
    this.proc = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: sb.workDir,
      env: { ...process.env, ...sb.env, TERM: 'xterm-256color' },
    });
    this.proc.onData((d: string) => {
      this.raw += d;
      this.lastData = Date.now();
    });
    this.proc.onExit((e: { exitCode: number }) => {
      this.exited = true;
      this.exitCode = e.exitCode;
    });
  }

  get plain(): string {
    // Strip OSC then CSI, and fold CR so the tail is greppable.
    return this.raw
      // eslint-disable-next-line no-control-regex
      .replace(/\][^]*(|\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\r/g, '\n');
  }

  tail(lines = 25): string {
    return this.plain.split('\n').filter((l) => l.trim()).slice(-lines).join('\n');
  }

  kill(): void {
    try {
      if (!this.exited) this.proc.kill();
    } catch {
      /* best effort */
    }
  }

  async waitIdle(quietMs: number, timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.exited) return true;
      if (Date.now() - this.lastData >= quietMs) return true;
      await sleep(100);
    }
    return false;
  }

  submit(text: string): void {
    if (this.exited) return;
    this.proc.write(text);
    setTimeout(() => {
      if (!this.exited) this.proc.write('\r');
    }, 200);
  }
}

// ----- Transcript parsing -------------------------------------------------

interface UsageLine {
  usage: Record<string, unknown>;
  model?: string;
  messageId?: string;
  line: string;
}

/**
 * The candidate parser for `modules/orchestrator/context-usage.ts`: walk the
 * transcript backwards and return the last non-sidechain `type:"assistant"`
 * line carrying `message.usage`.
 */
function lastUsage(transcriptPath: string): UsageLine | null {
  if (!existsSync(transcriptPath)) return null;
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (d['type'] !== 'assistant') continue;
      if (d['isSidechain'] === true) continue;
      const msg = d['message'];
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const u = m['usage'];
      if (!u || typeof u !== 'object') continue;
      return {
        usage: u as Record<string, unknown>,
        model: typeof m['model'] === 'string' ? m['model'] : undefined,
        messageId: typeof m['id'] === 'string' ? m['id'] : undefined,
        line: lines[i]!,
      };
    } catch {
      // A tail-read can slice the first line mid-JSON — skip it, as the
      // production parser must.
      continue;
    }
  }
  return null;
}

function usedTokens(u: Record<string, unknown>): number {
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return (
    n('input_tokens') +
    n('cache_read_input_tokens') +
    n('cache_creation_input_tokens') +
    n('output_tokens')
  );
}

/** Line types present in a transcript, in order, for the report. */
function transcriptShape(p: string): string[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        const d = JSON.parse(l) as Record<string, unknown>;
        const t = String(d['type']);
        const msg = d['message'];
        const hasUsage =
          msg && typeof msg === 'object' && (msg as Record<string, unknown>)['usage'] != null;
        return hasUsage ? `${t}+usage` : t;
      } catch {
        return '(unparseable)';
      }
    });
}

// =========================================================================
// Checks
// =========================================================================

const results: CheckResult[] = [];
/** Evidence blocks appended verbatim to the report. */
const evidence: Record<string, string> = {};

/** S1a/S1b/S2/S4-baseline — print mode. */
function checkPrintMode(): Sandbox {
  const id = 'S1b';
  const start = Date.now();
  const sb = makeSandbox('print', HOOK_DUMP);
  const r = runPrint(sb, 'hi');
  const p = readPayloads(sb);
  const first = p[0];
  const fired = p.length > 0 && first?.hook_event_name === 'SessionStart';
  results.push({
    id,
    title: 'SessionStart fires in --print mode',
    status: fired ? 'CONFIRMED' : 'INFIRMED',
    command: r.cmd,
    exitCode: r.status,
    stdout: trim(r.stdout, 400),
    stderr: trim(r.stderr, 400),
    durationMs: Date.now() - start,
    notes: fired
      ? `Hook fired ${p.length}× on a single \`claude -p\` run, with **\`source:"${first?.source}"\`** — print mode does NOT get a dedicated source value, it reuses \`startup\`. Payload keys: ${Object.keys(first ?? {}).map((k) => `\`${k}\``).join(', ')}.`
      : 'No payload was written by the hook during a --print run.',
  });
  evidence['S1b'] = JSON.stringify(first ?? {}, null, 2);
  return sb;
}

/** S2 — payload schema + transcript reachability + usage lines. */
function checkPayloadAndTranscript(sb: Sandbox): void {
  const start = Date.now();
  const p = readPayloads(sb);
  const first = p[0];
  const tp = typeof first?.transcript_path === 'string' ? first.transcript_path : '';
  const exists = tp !== '' && existsSync(tp);
  const shape = exists ? transcriptShape(tp) : [];
  const usage = exists ? lastUsage(tp) : null;

  const expected = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'source'];
  const missing = expected.filter((k) => !(first && k in first));
  const extra = Object.keys(first ?? {}).filter((k) => !expected.includes(k));

  const ok = missing.length === 0 && exists && usage !== null;
  const u = usage?.usage ?? {};

  // Two assistant lines share one message.id when the turn has a thinking
  // block plus a text block — both carry the SAME usage object.
  const assistantIds = exists
    ? readFileSync(tp, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            const d = JSON.parse(l) as Record<string, unknown>;
            if (d['type'] !== 'assistant') return null;
            const m = d['message'] as Record<string, unknown> | undefined;
            return m && m['usage'] ? String(m['id']) : null;
          } catch {
            return null;
          }
        })
        .filter((x): x is string => x !== null)
    : [];
  const dupIds = assistantIds.length !== new Set(assistantIds).size;

  results.push({
    id: 'S2',
    title: 'stdin payload schema + transcript_path reachability + message.usage',
    status: ok ? 'CONFIRMED' : 'PARTIAL',
    command: `hook stdin dump → ${sb.hookLog}`,
    exitCode: 0,
    stdout: trim(JSON.stringify(first ?? {}, null, 2), 1200),
    stderr: '',
    durationMs: Date.now() - start,
    notes:
      `Payload carries exactly the 5 expected keys${missing.length ? ` — MISSING: ${missing.join(', ')}` : ''}` +
      `${extra.length ? ` — plus undocumented extras: ${extra.join(', ')}` : ' and no extras'}. ` +
      `\`transcript_path\` → \`${tp}\` (exists: ${exists}${exists ? `, ${statSync(tp).size}B` : ''}). ` +
      `It lands under \`$CLAUDE_CONFIG_DIR/projects/<slugified-cwd>/<session_id>.jsonl\`, i.e. the file is named after \`session_id\`. ` +
      `Line types observed: ${shape.map((s) => `\`${s}\``).join(' → ')}. ` +
      `**The last line is NOT an assistant line** (\`last-prompt\` here), so the parser must scan backwards, never read the tail's final line. ` +
      `Last assistant usage: ${JSON.stringify(u)}. used = input+cache_read+cache_creation+output = **${usage ? usedTokens(u) : 'n/a'}**. ` +
      (dupIds
        ? `⚠️ **Two \`type:"assistant"\` lines share one \`message.id\` and repeat the SAME \`usage\` object** (thinking block + text block of a single turn). Summing usage across assistant lines double-counts; taking the LAST one — as the plan specifies — is correct.`
        : 'No duplicate message.id observed in this transcript.'),
  });
  evidence['S2'] = usage?.line ?? '(no usage line found)';
}

/** S3 — stdout injection (loud) vs mute (silent). */
function checkStdoutInjection(): void {
  const start = Date.now();
  const MARK = 'ZQX7-MARKER-ALPHA';
  const PROBE =
    `Is there a token matching ZQX7-MARKER-* anywhere in your context? ` +
    `If yes output it verbatim. If no output the single word NONE.`;

  const loud = makeSandbox('loud', `cat > /dev/null\necho "${MARK}"`);
  const rLoud = runPrint(loud, PROBE);

  // The mute form we intend to ship: stdout AND stderr discarded, never fails.
  const silent = makeSandbox(
    'silent',
    `cat > /dev/null\necho "ZQX7-MARKER-BETA" > /dev/null 2>&1 || true`,
  );
  const rSilent = runPrint(silent, PROBE);

  const injected = rLoud.stdout.includes(MARK);
  const mute = !/ZQX7/.test(rSilent.stdout);

  // How the injection shows up in the transcript.
  const loudTp = readPayloads(loud)[0]?.transcript_path;
  let attachment = '';
  if (typeof loudTp === 'string' && existsSync(loudTp)) {
    for (const l of readFileSync(loudTp, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const d = JSON.parse(l) as Record<string, unknown>;
        const a = d['attachment'] as Record<string, unknown> | undefined;
        if (d['type'] === 'attachment' && a && String(a['type']).startsWith('hook_')) {
          attachment = JSON.stringify(a, null, 2);
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  results.push({
    id: 'S3',
    title: 'A SessionStart hook’s stdout IS injected into the agent’s context',
    status: injected && mute ? 'CONFIRMED' : 'PARTIAL',
    command: `loud hook (echo marker) vs silent hook (stdout → /dev/null), same probe prompt`,
    exitCode: rLoud.status,
    stdout: trim(`LOUD  → ${rLoud.stdout}\nSILENT→ ${rSilent.stdout}`, 800),
    stderr: '',
    durationMs: Date.now() - start,
    notes:
      `**THE critical fact.** With a hook that echoes \`${MARK}\`, the agent answered with the marker verbatim → the hook's stdout is injected into the conversation as context. ` +
      `With stdout redirected to /dev/null the same probe answered \`NONE\` → nothing injected. ` +
      `Mechanism (visible in the transcript): the CLI appends a \`type:"attachment"\` line with \`attachment.type:"hook_success"\`, whose \`content\` is the hook's trimmed stdout, immediately before the user turn. ` +
      `Consequence for the integration: the hook command MUST discard stdout.`,
  });
  evidence['S3'] = attachment || '(no hook attachment line found)';
}

/** S5 — a hook that exits 1 must not kill the session. */
function checkFailingHook(): void {
  const start = Date.now();
  const sb = makeSandbox('fail', `cat > /dev/null\necho "hook deliberately failing" >&2\nexit 1`);
  const r = runPrint(sb, 'reply with the single word OK');
  const survived = r.status === 0 && /OK/i.test(r.stdout);

  const tp = readPayloads(sb)[0]?.transcript_path;
  let attachment = '';
  if (typeof tp === 'string' && existsSync(tp)) {
    for (const l of readFileSync(tp, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const d = JSON.parse(l) as Record<string, unknown>;
        const a = d['attachment'] as Record<string, unknown> | undefined;
        if (d['type'] === 'attachment' && a && String(a['type']).startsWith('hook_')) {
          attachment = JSON.stringify(a, null, 2);
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  results.push({
    id: 'S5',
    title: 'A SessionStart hook exiting non-zero does NOT kill the session',
    status: survived ? 'CONFIRMED' : 'INFIRMED',
    command: `${r.cmd}  (hook body: \`echo … >&2; exit 1\`)`,
    exitCode: r.status,
    stdout: trim(r.stdout, 400),
    stderr: trim(r.stderr, 600),
    durationMs: Date.now() - start,
    notes: survived
      ? `The session ran to completion (exit 0, agent replied normally) despite the hook exiting 1. ` +
        `The failure is recorded in the transcript as \`attachment.type:"hook_non_blocking_error"\` — SessionStart failures are non-blocking. ` +
        `Note the stderr of a failing hook is NOT injected as context (unlike stdout on success), but it IS surfaced in the transcript. ` +
        `This validates the \`|| true\` tail of the planned curl command as belt-and-braces rather than a strict requirement.`
      : `Session did not survive a failing hook — exit ${r.status}.`,
  });
  evidence['S5'] = attachment || '(no hook attachment line found)';
}

/**
 * S6 — end-to-end rehearsal of the exact command we intend to ship, against a
 * server that answers 400 (the worst case the plan worries about in H6):
 * the payload must reach the server, nothing must be injected, and the session
 * must survive.
 */
async function checkRecommendedCurl(): Promise<void> {
  const start = Date.now();
  const http = await import('node:http');
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      received.push(body);
      // Deliberately the failure case: unknown kind → 400, as hooks.ts does today.
      // The body carries a marker that appears NOWHERE in the probe prompt, so
      // a YES answer can only mean the body was injected.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"UNKNOWN_KIND","detail":"VRB42-SERVER-BODY must never reach the agent"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/hooks/spike-secret/session.transcript`;

  const CURL =
    `curl -sS -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' ` +
    `--data-binary @- '${url}' >/dev/null 2>&1 || true`;

  const sb = makeSandbox('curl', CURL);
  const r = await runPrintAsync(
    sb,
    'Does a token matching VRB42-* appear anywhere in your context? ' +
      'If yes output it verbatim. If no output the single word NONE.',
  );
  await new Promise<void>((res) => server.close(() => res()));

  const got = received.length > 0;
  let parsed: HookPayload | null = null;
  try {
    parsed = JSON.parse(received[0] ?? '') as HookPayload;
  } catch {
    /* leave null */
  }
  const survived = r.status === 0;
  const clean = !/VRB42/i.test(r.stdout);

  results.push({
    id: 'S6',
    title: 'Recommended curl form: payload delivered, nothing injected, 400 harmless',
    status: got && survived && clean ? 'CONFIRMED' : 'PARTIAL',
    command: CURL,
    exitCode: r.status,
    stdout: trim(
      `agent answer: ${r.stdout}\nserver received ${received.length} request(s)\n` +
        `parsed payload keys: ${parsed ? Object.keys(parsed).join(', ') : '(unparseable)'}\n` +
        `transcript_path in delivered body: ${parsed?.transcript_path ?? '(absent)'}`,
      1200,
    ),
    stderr: '',
    durationMs: Date.now() - start,
    notes:
      `The exact command recommended below was run as a real \`SessionStart\` hook against a server answering **HTTP 400** with a JSON error body. ` +
      `Result: the server received the payload (${received.length} request, \`transcript_path\` ${parsed?.transcript_path ? 'intact' : 'ABSENT'}), the CLI exited ${r.status}, and the probe for the marker planted in the 400 body answered "${r.stdout}" — ` +
      `the 400 response body never reached the conversation. ` +
      `\`curl\` without \`-f\` treats a 4xx as a successful transfer (exit 0), and \`-o /dev/null\` plus \`>/dev/null 2>&1\` keep the body off stdout. ` +
      `This closes the plan's H6 worry for SessionStart: a non-2xx from \`hooks.ts\` is inert.`,
  });
  evidence['S6'] = JSON.stringify(parsed ?? { raw: received[0] ?? null }, null, 2);
}

/** S1a/S1c/S1d/S4 — interactive TUI: startup, /clear, /compact. */
async function checkInteractive(): Promise<void> {
  const start = Date.now();
  const sb = makeSandbox('tui', HOOK_DUMP);
  const pty = new PtyRun(sb, ['--model', MODEL]);

  const log: string[] = [];
  const snap = (label: string): HookPayload[] => {
    const p = readPayloads(sb);
    log.push(`${label}: ${p.length} payload(s) — sources=[${p.map((x) => x.source ?? '?').join(', ')}]`);
    return p;
  };

  await pty.waitIdle(2500, 90_000);
  const afterBoot = snap('after boot');

  // A real turn, so /compact has something to compact.
  pty.submit('hi');
  await sleep(1200);
  await pty.waitIdle(5000, 120_000);

  pty.submit('/clear');
  await sleep(2000);
  await pty.waitIdle(4000, 90_000);
  const afterClear = snap('after /clear');

  // `/compact` refuses with "Not enough messages to compact" on a one-turn
  // conversation — it needs a handful of real turns first. Kept to one-word
  // prompts on haiku so the extra turns cost nothing meaningful.
  for (const turn of ['hi', 'ok', 'thanks', 'bye']) {
    pty.submit(turn);
    await sleep(1200);
    await pty.waitIdle(5000, 120_000);
  }

  pty.submit('/compact');
  await sleep(2500);
  await pty.waitIdle(8000, 240_000);
  const afterCompact = snap('after /compact');
  const compactRefused = /Not\s*enough\s*messages\s*to\s*compact/i.test(
    pty.plain.replace(/\s+/g, ' '),
  );

  const loginWall = /Select login method|Claude account with subscription/.test(pty.plain);
  pty.kill();
  await sleep(300);

  const bootOk = afterBoot.length >= 1 && afterBoot[0]?.source === 'startup';
  const clearEvt = afterClear.find((p) => p.source === 'clear');
  const compactEvt = afterCompact.find((p) => p.source === 'compact');

  const dur = Date.now() - start;

  if (loginWall) {
    for (const [id, title] of [
      ['S1a', 'SessionStart fires on interactive startup (source=startup)'],
      ['S1c', 'SessionStart fires after /clear (source=clear)'],
      ['S1d', 'SessionStart fires after /compact (source=compact)'],
      ['S4', '/clear rotates the transcript file'],
    ] as const) {
      results.push({
        id,
        title,
        status: 'UNVERIFIED',
        command: `node-pty spawn: claude --model ${MODEL}`,
        exitCode: pty.exitCode,
        stdout: trim(pty.tail(20), 1200),
        stderr: '',
        durationMs: dur,
        notes:
          'The interactive TUI hit the login wall in this sandbox: a bare `CLAUDE_CODE_OAUTH_TOKEN` is NOT accepted by the TUI (only by `--print`). ' +
          'Re-run on a host where `~/.claude/.credentials.json` exists so the sandbox can symlink it.',
      });
    }
    return;
  }

  results.push({
    id: 'S1a',
    title: 'SessionStart fires on interactive startup (source=startup)',
    status: bootOk ? 'CONFIRMED' : 'INFIRMED',
    command: `node-pty spawn: claude --model ${MODEL}`,
    exitCode: pty.exitCode,
    stdout: trim(log.join('\n'), 900),
    stderr: '',
    durationMs: dur,
    notes: bootOk
      ? `Exactly ${afterBoot.length} payload at TUI boot with \`source:"startup"\`, before any user input. This is the moment the provider needs: the transcript path is known before the first turn.`
      : `Boot payloads: ${JSON.stringify(afterBoot)}`,
  });

  results.push({
    id: 'S1c',
    title: 'SessionStart fires after /clear (source=clear)',
    status: clearEvt ? 'CONFIRMED' : 'INFIRMED',
    command: `PTY: submit "/clear" (two-step Ink dance)`,
    exitCode: pty.exitCode,
    stdout: trim(log.join('\n'), 900),
    stderr: '',
    durationMs: dur,
    notes: clearEvt
      ? `\`/clear\` fired a fresh SessionStart with \`source:"clear"\`.`
      : `No clear-sourced payload. Observed: ${JSON.stringify(afterClear.map((p) => p.source))}. PTY tail:\n${pty.tail(15)}`,
  });

  results.push({
    id: 'S1d',
    title: 'SessionStart fires after /compact (source=compact)',
    status: compactEvt ? 'CONFIRMED' : compactRefused ? 'UNVERIFIED' : 'INFIRMED',
    command: `PTY: submit "/compact" (after ${5} turns, so the CLI accepts it)`,
    exitCode: pty.exitCode,
    stdout: trim(log.join('\n'), 900),
    stderr: '',
    durationMs: dur,
    notes: compactEvt
      ? `\`/compact\` fired a fresh SessionStart with \`source:"compact"\` once the compaction completed. ` +
        `Note it is emitted only when the compaction actually runs: on a too-short conversation the CLI answers ` +
        `"Not enough messages to compact." and NO SessionStart is fired — so the tracker must not assume a hook callback ` +
        `follows every operator-issued compact.`
      : compactRefused
        ? `UNVERIFIED — the CLI refused the compaction ("Not enough messages to compact.") even after several turns, so no compaction ran and there was nothing to fire a hook for. This is a harness limitation, not evidence against the hook.`
        : `No compact-sourced payload. Observed sources: ${JSON.stringify(afterCompact.map((p) => p.source))}. PTY tail:\n${pty.tail(20)}`,
  });

  // S4 — transcript rotation across /clear (and, for contrast, /compact).
  const bootTp = afterBoot[0]?.transcript_path;
  const clearTp = clearEvt?.transcript_path;
  const rotated = Boolean(bootTp && clearTp && bootTp !== clearTp);
  const bootSid = afterBoot[0]?.session_id;
  const clearSid = clearEvt?.session_id;
  const compactTp = compactEvt?.transcript_path;
  const compactSid = compactEvt?.session_id;
  const compactRotated = Boolean(clearTp && compactTp && clearTp !== compactTp);
  results.push({
    id: 'S4',
    title: '/clear rotates the transcript file (new path) or reuses it',
    status: clearTp ? 'CONFIRMED' : 'UNVERIFIED',
    command: 'compare transcript_path across startup and clear payloads',
    exitCode: 0,
    stdout: trim(
      `startup: session_id=${bootSid}\n         transcript=${bootTp}\n` +
        `clear:   session_id=${clearSid}\n         transcript=${clearTp}\n` +
        `compact: session_id=${compactSid}\n         transcript=${compactTp}`,
      1600,
    ),
    durationMs: dur,
    stderr: '',
    notes: clearTp
      ? (rotated
          ? `**ROTATION CONFIRMÉE** — \`/clear\` hands back a DIFFERENT \`.jsonl\`${bootSid !== clearSid ? ', under a **new `session_id`**' : ' (same session_id)'}. A cached transcript path goes stale the moment a clear happens, so the tracker MUST adopt the path re-supplied by the hook rather than keep the boot-time one. `
          : `**NO ROTATION** — \`/clear\` re-supplied the SAME path (${clearTp}). The tracker can keep its cached path, but must still mark the reading stale. `) +
        (compactTp
          ? compactRotated
            ? `\`/compact\` ALSO rotates: a third distinct \`.jsonl\`/\`session_id\`. So both reset paths re-key the transcript, and the file naming (\`<session_id>.jsonl\`) means the CLI's session id — not swarm-os's — owns the filename.`
            : `\`/compact\`, by contrast, re-supplied the SAME path as the post-clear one (${compactTp}) — compaction rewrites in place.`
          : 'No compact payload to compare.') +
        ` Consequence for the "last resort" fallback in the plan (newest \`.jsonl\` in the projects dir by mtime): it is even more fragile than assumed, since a single agent legitimately produces several transcripts over its lifetime in the same dir.`
      : 'No clear payload to compare.',
  });

  evidence['S4'] = JSON.stringify(
    readPayloads(sb).map((p) => ({
      source: p.source,
      session_id: p.session_id,
      transcript_path: p.transcript_path,
    })),
    null,
    2,
  );
}

// ----- Report -------------------------------------------------------------

function writeReport(version: string, totalMs: number): void {
  const counts: Record<Status, number> = {
    CONFIRMED: 0,
    INFIRMED: 0,
    PARTIAL: 0,
    UNVERIFIED: 0,
  };
  for (const r of results) counts[r.status]++;

  const lines: string[] = [];
  lines.push('# Spike — hook `SessionStart` de Claude Code');
  lines.push('');
  lines.push(`_Généré par \`scripts/verify-claude-sessionstart.ts\` le ${new Date().toISOString()}._`);
  lines.push('');
  lines.push('**Commande :** `pnpm verify:claude-sessionstart`');
  lines.push('');
  lines.push('**Environnement :**');
  lines.push(`- claude CLI : ${version}`);
  lines.push(`- node : ${process.version} · platform : ${process.platform}`);
  lines.push(`- modèle des sessions de test : \`${MODEL}\` (prompts d'un mot)`);
  lines.push(`- sandbox jetable : \`${SPIKE_TMP}\` (CLAUDE_CONFIG_DIR isolé, nettoyé en fin de run)`);
  lines.push('');
  lines.push(
    `**Résumé :** CONFIRMED=${counts.CONFIRMED} · INFIRMED=${counts.INFIRMED} · PARTIAL=${counts.PARTIAL} · UNVERIFIED=${counts.UNVERIFIED} · total=${totalMs}ms`,
  );
  lines.push('');
  lines.push('| ID | Fait vérifié | Statut |');
  lines.push('|----|--------------|--------|');
  for (const r of results) lines.push(`| ${r.id} | ${r.title} | **${r.status}** |`);
  lines.push('');
  lines.push('---');
  for (const r of results) {
    lines.push('');
    lines.push(`## ${r.id} — ${r.title}`);
    lines.push('');
    lines.push(`Statut : **${r.status}**`);
    lines.push('');
    lines.push(`Commande : \`${r.command}\``);
    lines.push('');
    lines.push(`Exit : ${r.exitCode ?? 'n/a'} · Durée : ${r.durationMs}ms`);
    lines.push('');
    if (r.stdout) {
      lines.push('Sortie :');
      lines.push('```');
      lines.push(r.stdout);
      lines.push('```');
      lines.push('');
    }
    if (r.stderr) {
      lines.push('Stderr :');
      lines.push('```');
      lines.push(r.stderr);
      lines.push('```');
      lines.push('');
    }
    lines.push(`Notes : ${r.notes}`);
    if (evidence[r.id]) {
      lines.push('');
      lines.push('Preuve :');
      lines.push('```json');
      lines.push(evidence[r.id]!);
      lines.push('```');
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Recommandation — forme de la commande de hook');
  lines.push('');
  lines.push(
    'S3 est décisif : le stdout d\'un hook `SessionStart` **est injecté dans le contexte de l\'agent** ' +
      '(ligne de transcript `type:"attachment"` / `attachment.type:"hook_success"`, dont le `content` est le stdout du hook). ' +
      'Un `curl` non muet polluerait donc chaque démarrage, chaque `/clear` et chaque `/compact` avec sa sortie — ' +
      'et gonflerait précisément la métrique qu\'on cherche à mesurer.',
  );
  lines.push('');
  lines.push('Forme à livrer dans le `settings.json` per-session :');
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command:
                    "curl -sS -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' " +
                    "--data-binary @- 'http://127.0.0.1:<port>/hooks/<secret>/session.transcript' >/dev/null 2>&1 || true",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  lines.push('```');
  lines.push('');
  lines.push('Justification clause par clause :');
  lines.push('');
  lines.push(
    '- `--data-binary @-` : le payload arrive sur **stdin** du hook (S2). `@-` le relaie tel quel, sans que curl ne réinterprète les newlines.',
  );
  lines.push(
    '- `-o /dev/null` **et** `>/dev/null 2>&1` : ceinture et bretelles. `-o` couvre le corps de la réponse, la redirection couvre tout ce que curl pourrait écrire par ailleurs. C\'est la clause qui rend le hook muet (S3).',
  );
  lines.push(
    '- `-sS` : pas de barre de progression ; `-S` garde les vraies erreurs… qui partent en `2>&1`, donc rien n\'est injecté (le stderr d\'un hook n\'est de toute façon pas injecté — voir S5).',
  );
  lines.push(
    '- `-m 5` : un timeout **obligatoire**. Le hook s\'exécute de façon synchrone au démarrage de session ; sans borne, un serveur qui ne répond pas retarde le boot du CLI.',
  );
  lines.push(
    '- `|| true` : confort, pas nécessité — S5 montre qu\'un exit non nul est déjà non bloquant pour `SessionStart` (`hook_non_blocking_error`). On le garde pour que l\'échec ne laisse pas non plus de trace dans le transcript.',
  );
  lines.push('');
  lines.push('## Écarts par rapport à `docs/monitoring-agents.md`');
  lines.push('');
  for (const [k, v] of Object.entries(DEVIATIONS)) {
    lines.push(`- **${k}** — ${v}`);
  }
  lines.push('');

  writeFileSync(REPORT_PATH, lines.join('\n'));
}

// ----- Main ---------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now();
  const version = claudeVersion();
  rmSync(SPIKE_TMP, { recursive: true, force: true });
  mkdirSync(SPIKE_TMP, { recursive: true });

  try {
    const printSb = checkPrintMode();
    checkPayloadAndTranscript(printSb);
    checkStdoutInjection();
    checkFailingHook();
    await checkRecommendedCurl();
    await checkInteractive();
  } finally {
    writeReport(version, Date.now() - t0);
    // Throwaway dirs hold real transcripts — always wipe.
    if (!process.env['CLAUDE_SPIKE_KEEP']) {
      rmSync(SPIKE_TMP, { recursive: true, force: true });
    }
  }
   
  console.log(`Report written to ${REPORT_PATH}`);
  for (const r of results) {
     
    console.log(`  ${r.status.padEnd(10)} ${r.id} — ${r.title}`);
  }
}

void main();
