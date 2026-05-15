import { useState } from 'react';
import { api } from '../api/client';

interface Props {
  orchestratorId: string;
}

/**
 * Top-of-orchestrator-view "send to all" textarea.
 *
 * Posts to `POST /orchestrators/:id/broadcast`. The button is disabled while
 * the request is in flight to avoid double-submits. Empty / whitespace-only
 * content is rejected client-side.
 *
 * The sender id on the server side is the literal string `'human'` (per
 * plan §11) — every active worker / lead in the team will see this in the
 * `from` field of the next `team.read_inbox()` call.
 */
export function BroadcastBar({ orchestratorId }: Props) {
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function handleSend() {
    const trimmed = content.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setLastResult(null);
    try {
      const r = await api.broadcastToOrchestrator(orchestratorId, trimmed);
      setLastResult(`delivered to ${r.delivered_to.length} session(s)`);
      setContent('');
    } catch (err) {
      setLastResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter sends; plain Enter inserts a newline.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="border border-slate-700 rounded p-2 bg-slate-900 mb-3">
      <div className="flex items-start gap-2">
        <textarea
          className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm font-mono resize-y min-h-[2.5rem]"
          placeholder="Broadcast to every session in this orchestrator (Cmd/Ctrl+Enter to send)…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={pending}
        />
        <button
          className="px-3 py-1.5 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void handleSend()}
          disabled={pending || content.trim().length === 0}
        >
          {pending ? 'Sending…' : 'Send to all'}
        </button>
      </div>
      {lastResult && (
        <div className="text-xs text-slate-400 mt-1">{lastResult}</div>
      )}
    </div>
  );
}
