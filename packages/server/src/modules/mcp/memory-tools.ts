import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, requireLead, logCall, type ToolContext } from './tools.js';
import { MemoryConflictError, MemoryError, MEMORY_NOTE_TYPES } from '../memory/store.js';

/**
 * MCP memory tools (docs/memoire-partagee.md §5) — the shared knowledge graph,
 * exposed to EVERY agent on the same `team-comms` server, right after the
 * built-in team-comms tools. All tools are open to leads and workers alike
 * (the point is a common brain every agent maintains); only `memory.delete` is
 * lead-only (destructive).
 *
 * Provenance (`created_by` / `team`) is stamped from the calling session, never
 * from the arguments, so a note always records who actually wrote it.
 */

/** The knowledge-graph node type enum, shared with the store DTO. */
const TYPE_ENUM = z.enum(
  MEMORY_NOTE_TYPES as unknown as [string, ...string[]],
);

/** Resolve the store or throw a clean MCP error (pre-memory test fixtures). */
function memoryOf(ctx: ToolContext, tool: string): NonNullable<ToolContext['memory']> {
  if (!ctx.memory) {
    logCall(tool, ctx, false, 'MEMORY_UNAVAILABLE');
    throw new McpError(
      ErrorCode.InternalError,
      'MEMORY_UNAVAILABLE: the shared memory store is not configured on this deployment',
    );
  }
  return ctx.memory;
}

export function registerMemoryTools(server: McpServer, ctxResolver: () => ToolContext): void {
  // ---- memory.search ----------------------------------------------------
  server.registerTool(
    'memory.search',
    {
      title: 'Search the shared knowledge graph',
      description:
        'Search the shared, deployment-wide memory (notes + wikilinks). Returns ranked hits with a snippet. Use this at the START of a task to recall what the swarm already knows. `mode` selects the engine: `text` (default, exact full-text FTS — backward-compatible), `semantic` (embedding cosine — recall by meaning), or `hybrid` (fuse both). `type` optionally narrows to one note type; `limit` defaults to 20. Each hit carries `via` (`fts`|`semantic`) when known. Semantic degrades gracefully: if embeddings are not configured on this deployment it falls back to text.',
      inputSchema: {
        query: z.string().min(1),
        mode: z.enum(['text', 'semantic', 'hybrid']).optional(),
        type: TYPE_ENUM.optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
      outputSchema: {
        results: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            type: z.string(),
            snippet: z.string(),
            score: z.number(),
            via: z.enum(['fts', 'semantic']).optional(),
          }),
        ),
      },
    },
    async (args) => {
      const ctx = ctxResolver();
      const a = args as {
        query: string;
        mode?: 'text' | 'semantic' | 'hybrid';
        type?: string;
        limit?: number;
      };
      const results = await memoryOf(ctx, 'memory.search').runSearch(a.query, {
        mode: a.mode ?? 'text',
        type: a.type ?? null,
        limit: a.limit ?? 20,
      });
      logCall('memory.search', ctx, true);
      return ok({ results });
    },
  );

  // ---- memory.read ------------------------------------------------------
  server.registerTool(
    'memory.read',
    {
      title: 'Read one note from the shared memory',
      description:
        'Fetch a full note by `name`: its body (markdown with `[[wikilinks]]`), metadata and its neighbours (`outLinks` / `inLinks`). Returns `{ found: false }` when the note does not exist.',
      inputSchema: {
        name: z.string().min(1),
      },
      outputSchema: {
        found: z.boolean(),
        note: z
          .object({
            name: z.string(),
            description: z.string(),
            type: z.string(),
            team: z.string().optional(),
            createdBy: z.string().optional(),
            createdAt: z.number(),
            updatedAt: z.number(),
            version: z.number(),
            body: z.string(),
            outLinks: z.array(z.string()),
            inLinks: z.array(z.string()),
          })
          .optional(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const a = args as { name: string };
      const note = memoryOf(ctx, 'memory.read').readNote(a.name);
      logCall('memory.read', ctx, true);
      return note ? ok({ found: true, note }) : ok({ found: false });
    },
  );

  // ---- memory.write -----------------------------------------------------
  server.registerTool(
    'memory.write',
    {
      title: 'Create or update a note in the shared memory',
      description:
        'Upsert a note in the shared, deployment-wide memory. `name` is a kebab-case slug (the note identity). `body` is markdown — link related notes with `[[other-note]]`, which become graph edges automatically. Call this AFTER a significant task to record facts, decisions and entities. Concurrency is guarded by `version`: pass `expectedVersion` (from a prior read) to fail on a conflicting concurrent write. `created_by` / `team` are stamped from your session automatically.',
      inputSchema: {
        name: z.string().min(1),
        description: z.string(),
        type: TYPE_ENUM,
        body: z.string(),
        expectedVersion: z.number().int().nonnegative().optional(),
      },
      outputSchema: {
        name: z.string(),
        version: z.number(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const a = args as {
        name: string;
        description: string;
        type: string;
        body: string;
        expectedVersion?: number;
      };
      try {
        const res = memoryOf(ctx, 'memory.write').upsertNote({
          name: a.name,
          description: a.description,
          type: a.type,
          body: a.body,
          createdBy: ctx.session.id,
          team: ctx.orchestrator.id,
          expectedVersion: a.expectedVersion,
        });
        logCall('memory.write', ctx, true);
        return ok(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logCall('memory.write', ctx, false, msg);
        if (err instanceof MemoryConflictError) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `VERSION_CONFLICT: ${msg} — re-read the note and retry`,
          );
        }
        if (err instanceof MemoryError) {
          throw new McpError(ErrorCode.InvalidParams, `${err.code}: ${msg}`);
        }
        throw new McpError(ErrorCode.InternalError, `MEMORY_WRITE_FAILED: ${msg}`);
      }
    },
  );

  // ---- memory.link ------------------------------------------------------
  server.registerTool(
    'memory.link',
    {
      title: 'Add a typed edge between two notes',
      description:
        'Create a directed edge `from` → `to` in the knowledge graph, with an optional `relation` label (defaults to "related"). Wikilinks in a body already create edges; use this for typed relations you want without editing the body.',
      inputSchema: {
        from: z.string().min(1),
        to: z.string().min(1),
        relation: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const a = args as { from: string; to: string; relation?: string };
      const done = memoryOf(ctx, 'memory.link').addLink(a.from, a.to, a.relation ?? null);
      logCall('memory.link', ctx, done);
      return ok({ ok: done });
    },
  );

  // ---- memory.list ------------------------------------------------------
  server.registerTool(
    'memory.list',
    {
      title: 'List notes in the shared memory',
      description:
        'List note metadata (no bodies), optionally filtered by `type` and/or name `prefix`. Cheap way to browse what exists before searching or writing.',
      inputSchema: {
        type: TYPE_ENUM.optional(),
        prefix: z.string().optional(),
      },
      outputSchema: {
        notes: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            type: z.string(),
            team: z.string().optional(),
            createdBy: z.string().optional(),
            createdAt: z.number(),
            updatedAt: z.number(),
            version: z.number(),
          }),
        ),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const a = args as { type?: string; prefix?: string };
      const notes = memoryOf(ctx, 'memory.list').list(a.type ?? null, a.prefix ?? null);
      logCall('memory.list', ctx, true);
      return ok({ notes });
    },
  );

  // ---- memory.delete (lead-only) ----------------------------------------
  server.registerTool(
    'memory.delete',
    {
      title: 'Delete a note from the shared memory (lead-only)',
      description:
        'Lead-only. Permanently remove a note (its file, index entry and edges) from the shared memory. Destructive — workers cannot call this. Returns `{ ok: true }` even if the note did not exist.',
      inputSchema: {
        name: z.string().min(1),
      },
      outputSchema: {
        ok: z.boolean(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'memory.delete');
      const a = args as { name: string };
      memoryOf(ctx, 'memory.delete').deleteNote(a.name);
      logCall('memory.delete', ctx, true);
      return ok({ ok: true });
    },
  );
}
