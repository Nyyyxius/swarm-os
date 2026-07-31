import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Spawner } from '../spawner/index.js';
import type { Session } from '../orchestrator/session.js';
import type { Orchestrator } from '../orchestrator/index.js';
import { registerTeamCommsTools, type ToolContext } from './tools.js';
import { registerMemoryTools } from './memory-tools.js';
import type { Config } from '../../config.js';
import type { MessagingDefaults } from '../orchestrator/messaging.js';
import type { BusMetricsCollector } from '../metrics/busMetrics.js';
import type { PluginToolRegistry } from '../plugins/mcp-registry.js';
import { withModule } from '../../logger.js';

const log = withModule('mcp');

/**
 * Loopback addresses we accept for the MCP listen() bind. Plan §14 makes
 * 127.0.0.1 a security-critical invariant — we hardcode the host inside
 * `start()` rather than reading an env var, but we double-check here so a
 * future refactor can't quietly widen the bind.
 */
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);

const MCP_PATH_RE = /^\/mcp\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)$/;

/**
 * Sanitise a session secret for logging. We only ever log the first 4
 * characters followed by an ellipsis; a 4-char prefix of a UUIDv4 has
 * 16 bits of entropy, which is enough to disambiguate two concurrent
 * sessions in a log without exposing the auth material.
 */
function redactSecret(secret: string): string {
  if (!secret || secret.length < 4) return '<redacted>';
  return `${secret.slice(0, 4)}...`;
}

/**
 * MCP Streamable HTTP server.
 *
 * Architecture (deliberate, see report at end of file):
 *
 * - One Node `http.Server` bound to **127.0.0.1** on `mcpPort` (default 8788).
 * - Routes ONLY `POST/GET/DELETE /mcp/:orch_id/:session_secret`.
 * - Per-request: parse the path, look up `(orch_id, session_secret)` against
 *   the Spawner; on success, build a fresh `SdkMcpServer` + a stateless
 *   `StreamableHTTPServerTransport` (sessionIdGenerator: undefined,
 *   enableJsonResponse: true), register the team-comms tools wired to a
 *   ToolContext capturing the resolved (orch, session), and hand the
 *   request to `transport.handleRequest()`.
 * - On invalid secret OR unknown orch → 404 with body `not found` (we never
 *   reveal whether the orch exists; see plan §14).
 * - We never log the secret beyond a 4-char prefix.
 *
 * **Why per-request, not per-session?** The MCP Streamable HTTP transport
 * the SDK ships in v1.29 has two modes: stateful (session id assigned by
 * the server, kept in-memory across requests) and stateless. The Phase 2
 * tools are pure synchronous reads — there's nothing to keep in transport
 * state. Per-request setup keeps the server completely free of session
 * lifecycle (no leaks if a claude PTY exits mid-request). Phase 3 may
 * promote to per-session if streaming becomes interesting.
 */
export class McpServer {
  private http: Server | null = null;
  private readonly messagingDefaults: MessagingDefaults;

  constructor(
    private readonly spawner: Spawner,
    private readonly mcpPort: number,
    /**
     * Optional. When omitted (test paths that pre-date Phase 3) we fall
     * back to plan-default values so the listener still boots. Production
     * code in `index.ts` always passes the loaded `Config`.
     */
    private readonly config?: Config,
    /**
     * Phase update_system S8 — bus health collector. When passed, each MCP
     * tool call is bracketed with `recordRequestStart` /
     * `recordRequestEnd(ok)` so `/metrics/bus` can compute latency &
     * err_rate over a 60 s sliding window. Optional so existing test paths
     * (pre-S8) keep working unchanged.
     */
    private readonly busMetrics?: BusMetricsCollector,
    /**
     * J2 — dynamic plugin tools. When passed, `handle()` registers every
     * currently-enabled plugin tool onto the per-request SdkMcpServer right
     * after the built-in team-comms tools. Optional so pre-J2 test paths boot.
     */
    private readonly pluginTools?: PluginToolRegistry,
  ) {
    this.messagingDefaults = {
      maxMessageSizeBytes: this.config?.maxMessageSizeBytes ?? 16 * 1024,
      idleThresholdMs: this.config?.idleThresholdMs ?? 2000,
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => {
        // Wrap to swallow handler errors so an exception in one request
        // doesn't bring the listener down.
        this.handle(req, res).catch((err) => {
          log.error({
            event: 'mcp.handler_failed',
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('internal error');
          }
        });
      });
      http.on('error', (err) => {
        // Propagate the listen() error path (EADDRINUSE etc.) only once.
        reject(err);
      });
      // Hardcoded loopback. NOT exposed via env. See plan §14 + class doc.
      const host = '127.0.0.1';
      if (!LOOPBACK_BINDS.has(host)) {
        // Defensive — if a future refactor accidentally swaps `host` for a
        // non-loopback address, fail fast at boot rather than silently
        // exposing the MCP server.
        reject(new Error(`MCP server bind host must be loopback, got: ${host}`));
        return;
      }
      http.listen(this.mcpPort, host, () => {
        const addr = http.address();
        const actualHost =
          addr && typeof addr === 'object' ? addr.address : 'unknown';
        const actualPort =
          addr && typeof addr === 'object' ? addr.port : this.mcpPort;
        if (!LOOPBACK_BINDS.has(actualHost)) {
          // Hard runtime assertion: we MUST be on loopback once listening.
          // Crash loudly rather than serve MCP on a public interface.
          log.fatal({
            event: 'mcp.bind_check_failed',
            host: actualHost,
            port: actualPort,
          });
          http.close();
          reject(new Error(`MCP bind verification failed: ${actualHost}`));
          return;
        }
        log.info({
          event: 'mcp.listen',
          host: actualHost,
          port: actualPort,
        });
        this.http = http;
        // Once we're successfully listening, stop using the constructor's
        // reject(): subsequent `error` events should just be logged.
        http.removeAllListeners('error');
        http.on('error', (err) => {
          log.error({ event: 'mcp.server_error', error: err.message });
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.http) return;
    await new Promise<void>((resolve) => {
      this.http?.close(() => resolve());
    });
    this.http = null;
  }

  // --- Request handling ---------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.mcpPort}`);
    const match = MCP_PATH_RE.exec(url.pathname);
    if (!match) {
      // Don't ever reveal whether `/mcp/...` is a meaningful prefix here —
      // a plain 404 is fine for any non-MCP path.
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const orchId = match[1] ?? '';
    const secret = match[2] ?? '';

    // Resolve the session from (orch_id, session_secret). On any miss we
    // return 404 — same status whether the orch is unknown or the secret
    // doesn't match — so we don't leak orch existence.
    const ctx = this.resolveContext(orchId, secret);
    if (!ctx) {
      log.warn({
        event: 'mcp.auth_fail',
        orch: orchId,
        secret: redactSecret(secret),
      });
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    // Read the request body before handing to the SDK transport. We could
    // skip pre-parsing and let the transport do it, but reading once gives
    // us a chance to short-circuit non-POST methods cleanly and keeps the
    // body available for both the transport and any future debug hooks.
    const parsedBody = await readJsonBody(req).catch((err) => err as Error);
    if (parsedBody instanceof Error) {
      // Streamable HTTP transport handles malformed JSON itself, but we
      // reject malformed bodies on POST early to avoid handing the SDK
      // garbage. GET requests have no body so we skip this entirely.
      if (req.method === 'POST') {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' },
            id: null,
          }),
        );
        return;
      }
    }

    // Phase-2 SDK idiom: per-request McpServer + stateless transport.
    // Stateless because the team-comms tools are synchronous reads with no
    // server-driven progress events to stream. See class doc for context.
    const sdkServer = new SdkMcpServer(
      { name: 'swarm-os-team-comms', version: '0.2.0-phase2' },
      { capabilities: {} },
    );
    registerTeamCommsTools(sdkServer, () => ctx);
    // Shared knowledge-graph tools (memory.*), registered right after the
    // built-in team-comms set so every agent sees them (docs memoire-partagee.md).
    registerMemoryTools(sdkServer, () => ctx);
    this.pluginTools?.registerAll(sdkServer, () => ctx);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // simpler request/response, no SSE in Phase 2
    });

    // Tear down per-request resources whenever the request ends, whether
    // the SDK closes them itself or the underlying socket dies first.
    res.on('close', () => {
      void transport.close();
      void sdkServer.close();
    });

    // S8 — bracket the transport call with the bus-health collector. We
    // measure only the `handleRequest()` span (NOT auth, body parsing, or
    // SDK connect) so the latency reflects what an operator perceives as
    // "MCP request → response". Auth-fail paths (resolveContext → null)
    // and oversize/malformed body paths returned earlier are intentionally
    // excluded — counting them would inflate err_rate_pct on every probe.
    const t0 = this.busMetrics?.recordRequestStart();
    let ok = true;
    try {
      await sdkServer.connect(transport);
      // The streamable HTTP transport accepts a pre-parsed body so we don't
      // re-read the stream. For initialize requests we let the SDK echo
      // server capabilities; isInitializeRequest is exported so we can log
      // whether this was an init or a tool call without inspecting the
      // payload further.
      const isInit =
        parsedBody !== undefined &&
        !(parsedBody instanceof Error) &&
        isInitializeRequest(parsedBody);
      if (isInit) {
        log.info({
          event: 'mcp.initialize',
          sid: ctx.session.id,
          orch: ctx.orchestrator.id,
        });
      }
      const bodyForTransport =
        parsedBody instanceof Error ? undefined : parsedBody;
      await transport.handleRequest(req, res, bodyForTransport);
    } catch (err) {
      ok = false;
      log.error({
        event: 'mcp.transport_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    } finally {
      if (t0 !== undefined) this.busMetrics?.recordRequestEnd(t0, ok);
    }
  }

  /**
   * Resolve `(orch_id, session_secret)` to a ToolContext.
   *
   * Returns `null` for either an unknown orchestrator id OR a wrong secret.
   * The caller MUST translate both to the same HTTP response (404, no body)
   * so a client can't probe orch existence.
   */
  private resolveContext(orchId: string, secret: string): ToolContext | null {
    const orch: Orchestrator | undefined = this.spawner.get(orchId);
    if (!orch) return null;
    // Find the session matching the secret. We iterate sessions of THIS
    // orchestrator only (cross-orchestrator secrets MUST never resolve, even
    // if they happen to collide).
    let session: Session | null = null;
    for (const s of orch.listSessions()) {
      if (s.sessionSecret === secret) {
        session = s;
        break;
      }
    }
    if (!session) return null;
    // Phase 3: thread `config` and `messagingDefaults` so worker tools can
    // reuse the workspace-cwd validator and the mailbox helpers without
    // looking at module-level globals.
    return {
      orchestrator: orch,
      session,
      spawner: this.spawner,
      // We synthesise a minimal Config-shaped object when running the
      // pre-Phase-3 test fixtures that didn't pass one in. The worker tools
      // need the workspaceRoot + caps to honour the same envelopes as the
      // REST surface — so production code MUST always pass `config`.
      config: this.config ?? ({} as Config),
      messagingDefaults: this.messagingDefaults,
      // Shared knowledge-graph store — lives on the Spawner (global to the
      // deployment). Absent in pre-memory test fixtures, in which case the
      // memory.* tools answer MEMORY_UNAVAILABLE rather than crashing.
      ...(this.spawner.memory ? { memory: this.spawner.memory } : {}),
    };
  }
}

/**
 * Read and JSON.parse the request body. Returns `undefined` for empty body
 * (e.g. GET requests). Throws on malformed JSON or oversize payloads.
 *
 * Cap at 1 MiB — MCP messages are small, anything larger is abuse.
 */
const MAX_MCP_BODY_BYTES = 1 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_MCP_BODY_BYTES) {
      throw new Error('payload too large');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}
