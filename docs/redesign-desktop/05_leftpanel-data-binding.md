# Step 5 (Phase B.5) — Binding données du `LeftPanel`

> Lié au plan global `docs/ui-redesign-desktop.md` §3.2 (table LeftPanel) et §5.1
> étape 5. Pré-requis : Step 2 (squelette `LeftPanel.tsx` + `BigGraph` +
> `Sparkline`) et Step 3 (`DesktopShell` derrière `#/`) déjà livrés. Cette
> étape fait passer le `LeftPanel` du squelette « props brutes » à des données
> réelles issues des hooks et de l'API.

---

## 1. Objectif

Câbler les 4 sections du `LeftPanel` (`MESSAGE FLOW`, `PER-TEAM TRAFFIC`,
`RECENTLY ENDED`, `BUS HEALTH`) sur les sources de données disponibles
post-S1–S12, en :

1. Ajoutant deux helpers API manquants (`api.getMetricsMessages`,
   `api.getMetricsBus`) avec types correspondant à la spec serveur
   (`MessagesMetricsSnapshot`, `BusMetricsSnapshot`).
2. Faisant de `LeftPanel` un composant **autonome** (ne demande qu'`orchestrators`
   + callbacks au parent) qui drive ses propres polls + ring buffer client.
3. Adaptant `OrchestratorView[]` → `LeftPanelTeam[] / LeftPanelEnded[]` via
   des transformateurs purs et testables.
4. Documentant le compromis S4 vs S9 et le mécanisme de bascule.

Les changements restent **purement client-side** : aucun nouvel endpoint
serveur, aucun changement de schéma. Build et tests existants doivent passer
sans régression.

---

## 2. Inventaire des hooks/endpoints par section

| Section | Source primaire | Source alternative | Cadence | Format |
|---|---|---|---|---|
| **MESSAGE FLOW** big-number + delta + 60-pt sparkline | `useGlobalMessageStats(orchestrators)` (S4, ring 60 pts côté client) | `api.getMetricsMessages()` (S9 — `.total`, `.per_minute`, `.global[60]`) | S4 : poll `useOrchestrators` 3 s + ring tick 60 s. S9 : poll 60 s | `{ total, perMinute, history[60] }` |
| **PER-TEAM TRAFFIC** msg count + sparkline 8 pts | `orch.msgCount` (S1) **+** `api.getMetricsMessages().per_orchestrator[orch.id]` (S9, 8 pts) | — | `useOrchestrators` 3 s + métriques 60 s | per-team sparkline indexé par `orch.id` (UUID) |
| **RECENTLY ENDED** | `useOrchestrators()` filtré sur `endedAt != null` | — | `useOrchestrators` 3 s + `useNow(30_000)` pour rafraîchir `formatRelative` | trié desc sur `endedAt`, badge-reason via `orch.stopReason` |
| **BUS HEALTH** 4 KPI | `api.getMetricsBus()` (S8) | — | toutes les **3 s** (cf. §3.2 du plan) | `{ latency_ms, throughput_msg_per_s, queue_depth, err_rate_pct, window_seconds: 60 }` |

### 2.1 Endpoints existants vs à ajouter

| Endpoint | Statut | Action |
|---|---|---|
| `GET /metrics/messages` | livré (S9, voir `packages/server/src/http/routes/metrics.ts:23`) | ajouter helper `api.getMetricsMessages()` dans `packages/web/src/api/client.ts` |
| `GET /metrics/bus` | livré (S8, voir `packages/server/src/http/routes/metrics.ts:28`) | ajouter helper `api.getMetricsBus()` dans `packages/web/src/api/client.ts` |
| Types `MessagesMetricsSnapshot` / `BusMetricsSnapshot` | définis côté serveur (`packages/server/src/modules/metrics/{aggregator,busMetrics}.ts`) | dupliquer la **forme** en TS côté web (pas d'import inter-package — `web` ne dépend pas de `server`) |
| `OrchestratorView.msgCount`, `health`, `stopReason`, `endedAt` | déjà sur `api/client.ts` (S1/S7/Phase 4) | inchangé |

### 2.2 Forme exacte des réponses serveur (à recopier en TS)

```ts
// packages/web/src/api/client.ts (à ajouter)

export interface MessagesMetricsSnapshot {
  /** Σ mailbox.messagesTotal across all orchs at call time. */
  total: number;
  /** Most recent 60-second delta (`global[59]`). */
  per_minute: number;
  /** 60 ints: msg/min over the trailing 60 minutes (oldest first). */
  global: number[];
  /** Per-orchestrator 8-point ring (oldest first). Keyed by orch.id (UUID). */
  per_orchestrator: Record<string, number[]>;
}

export interface BusMetricsSnapshot {
  /** Sliding mean MCP RTT (ms) over the trailing 60 s window. */
  latency_ms: number;
  /** Mean bus throughput (messages / second) over the trailing window. */
  throughput_msg_per_s: number;
  /** Instantaneous Σ mailbox.totalSize() across every orch. */
  queue_depth: number;
  /** Sliding error rate (%) over the trailing window. */
  err_rate_pct: number;
  /** Constant 60 — handy for UI labelling. */
  window_seconds: number;
}

// Dans `export const api = { … }`, ajouter :
getMetricsMessages: () =>
  request<MessagesMetricsSnapshot>('GET', '/metrics/messages'),
getMetricsBus: () =>
  request<BusMetricsSnapshot>('GET', '/metrics/bus'),
```

> Note : `getMetricsBus` peut renvoyer 404 si le serveur a été instancié sans
> `BusMetricsCollector` (cf. `metrics.ts:27`). Le hook qui le consomme doit
> tolérer ça (essayer une fois, puis afficher `—` sur les 4 cases — voir §3.5).

---

## 3. Adapter functions (toutes pures, donc testables)

Toutes les transformations vivent dans un nouveau module **`packages/web/src/lib/leftPanelAdapters.ts`**. Le composant ne fait que les appeler. Cela garde le composant déclaratif et permet d'écrire des tests unitaires (cf. §9).

### 3.1 `OrchestratorView` → `LeftPanelTeam`

```ts
// packages/web/src/lib/leftPanelAdapters.ts

import type { OrchestratorView } from '../api/client';
import type { LeftPanelTeam, LeftPanelEnded } from
  '../components/desktop/LeftPanel';

/**
 * Construit le tag `ONLINE | STARTING | OFFLINE` (cf. §3.2 du plan global) à
 * partir du couple `(orch.status, orch.health)`.
 *
 * Règles :
 *   - `health === 'stopped'` OU `status ∈ {stopped, failed, stopping}` → OFFLINE
 *   - `status === 'starting'`                                         → STARTING
 *   - sinon                                                            → ONLINE
 *
 * `OrchestratorStatus` upstream = `'starting' | 'running' | 'stopping' |
 *   'stopped' | 'failed'` (cf. `api/client.ts:20`).
 *
 * Le composant peut aussi consulter `mapOrchestratorStatusToVisual(status)`
 * (S3) si on veut un tooltip riche, mais pour la **couleur muted** on regarde
 * directement `health === 'stopped'` comme demandé par le plan.
 */
export type OnlineTag = 'ONLINE' | 'STARTING' | 'OFFLINE';

export function deriveTag(orch: OrchestratorView): OnlineTag {
  if (
    orch.health === 'stopped' ||
    orch.status === 'stopped' ||
    orch.status === 'failed' ||
    orch.status === 'stopping'
  ) {
    return 'OFFLINE';
  }
  if (orch.status === 'starting') return 'STARTING';
  return 'ONLINE';
}

/**
 * `purpose` court (≤ 16 chars upper-case) pour la ligne PER-TEAM TRAFFIC.
 * On n'a pas de champ `purpose` sur OrchestratorView ; on retombe sur `role`,
 * lui-même synchronisé avec `RoleView.label`. Si `role` est trop long, on
 * tronque.
 */
export function derivePurpose(orch: OrchestratorView): string {
  const raw = (orch.role || '—').toUpperCase();
  return raw.length > 16 ? raw.slice(0, 15) + '…' : raw;
}

/**
 * Transforme un OrchestratorView **actif** en `LeftPanelTeam`.
 * - `actifs` = `endedAt == null` (orchestrators non terminés)
 * - `spark` est lookup-é dans `perOrchMetrics` (S9) ; si absent → tableau vide
 *   (la Sparkline gère le cas en ne rendant rien — cf. proto v2 panels.jsx:16)
 */
export function toLeftPanelTeam(
  orch: OrchestratorView,
  perOrchMetrics: Record<string, number[]> | null,
): LeftPanelTeam {
  return {
    id: orch.id,
    name: orch.name,
    purpose: derivePurpose(orch),
    msgCount: orch.msgCount ?? 0,
    status: orch.status,            // brut — LeftPanel a la logique tag/muted
    leadId: orch.leadSessionId ?? orch.id, // fallback si pas de lead exposé
    workerCount: Math.max(0, orch.sessions.length - 1), // lead = 1, reste = workers
    spark: perOrchMetrics?.[orch.id] ?? [],
  };
}

/**
 * Filtre + transforme + trie les orchestrators terminés.
 * - filter : `endedAt != null`
 * - sort   : desc sur `endedAt` (plus récent en premier)
 * - badge-reason :
 *     prioritaire : `orch.stopReason` si présent (Phase 4)
 *     fallback    : dérivé de `orch.status` ('failed' → 'failed', sinon 'exited')
 */
export function toLeftPanelEnded(orch: OrchestratorView): LeftPanelEnded {
  const fallbackReason: string =
    orch.status === 'failed' ? 'failed' : 'exited';
  // Normalisation : le badge-reason CSS attend lower-case (cf. proto :
  // `.badge-reason.exited` / `.killed` / `.failed` / `.server-restart`).
  const rawReason = (orch.stopReason ?? fallbackReason).toLowerCase();
  return {
    id: orch.id,
    name: orch.name,
    purpose: derivePurpose(orch),
    endedAt: orch.endedAt ?? '',
    reason: rawReason,
    agentCount: orch.sessions.length,
  };
}

export function filterActive(
  orchestrators: readonly OrchestratorView[],
): OrchestratorView[] {
  return orchestrators.filter((o) => o.endedAt == null);
}

export function filterEnded(
  orchestrators: readonly OrchestratorView[],
): OrchestratorView[] {
  return orchestrators
    .filter((o) => o.endedAt != null)
    .sort((a, b) => {
      const ta = Date.parse(a.endedAt ?? '');
      const tb = Date.parse(b.endedAt ?? '');
      // Date.parse NaN → 0 → entrées invalides vont en queue (acceptable)
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
}

/**
 * Cap visuel : on rend max N entrées terminées (le plan global ne fixe pas
 * de limite, le proto v2 affiche `ended.length` directement, mais en prod on
 * peut accumuler des centaines de teams sur une longue session). 20 est un
 * compromis raisonnable ; au-delà l'opérateur consulte l'historique
 * complet via une page dédiée (hors scope v1).
 */
export const ENDED_DISPLAY_CAP = 20;
```

### 3.2 Format `purpose` — choix conscient

Le proto v2 a un champ `purpose` (`"NOVEL DRAFT"`, `"BUILD VERIFY"`, etc.)
qui n'existe pas côté backend. Trois options :

1. **Recommandé** : retomber sur `role.toUpperCase()` (déjà l'identifiant
   sémantique le plus proche). Cohérent avec ce que la TopBar v2 fera dans le
   pill-body.
2. Ajouter un champ `purpose` sur `OrchestratorView` (changement serveur,
   hors scope step 5).
3. Garder vide / `'—'`. Visuellement pauvre, écarté.

→ On part sur (1), comme dans `derivePurpose` ci-dessus.

### 3.3 Granularité de la sparkline per-team

- Le ring S9 = 8 points (`PER_ORCH_RING_SIZE = 8` dans `aggregator.ts:35`),
  un point par minute → couvre 8 minutes.
- Pour les teams **créées il y a < 8 min**, le ring contient des zéros en
  préfixe (pré-alloué). Visuellement OK : la ligne démarre à plat.
- Pour les teams **terminées** : §6.5 de `aggregator.ts` décrit le decay
  graceful (8 zéros poussés au fil des ticks). Donc on affiche la sparkline
  même pour les teams récemment terminées qui apparaîtraient dans la liste
  active si jamais le filtre est mal posé — mais on les filtre via
  `filterActive` donc le cas est théorique.

### 3.4 Couleur muted / sparkColor

Logique tirée du proto (`panels.jsx:84-85`) + plan §3.2 :

```ts
function sparkColor(orch: OrchestratorView): string {
  const offline = orch.health === 'stopped'
    || orch.status === 'stopped'
    || orch.status === 'failed';
  return offline ? '#5a4d3f' : 'var(--amber)';
}
```

À placer dans `leftPanelAdapters.ts` ou inline dans `LeftPanel.tsx`. Le code
§5 ci-dessous le met inline pour simplicité (même endroit que le rendu de la
row).

---

## 4. Choix S4 vs S9 pour MESSAGE FLOW

### 4.1 Comparaison

| Critère | S4 (`useGlobalMessageStats`) | S9 (`api.getMetricsMessages`) |
|---|---|---|
| Source | Σ `orch.msgCount` côté client + ring 60 entrées dans `useState` | aggregator serveur, ring 60 dans `MessagesAggregator` |
| Persistance | **non** — reset au F5, à la remount du composant | **non plus** — reset au restart serveur (cf. `09_metrics_messages.md` §7.3) |
| Latence d'apparition | total = instantané (re-render à chaque poll 3 s) ; delta + history = 60 s par tick | total + per_minute + global = quantum 60 s (lus tels-quels du serveur) |
| Concordance multi-clients | **non** — chaque navigateur a sa propre série | **oui** — tous les opérateurs voient la même courbe |
| Coût bande passante | nul (pure dérivation côté client) | +1 GET / 60 s (~400 octets payload) |
| Coût implé | trivial, hook déjà livré + testé (S4) | +1 hook custom + +1 helper api |
| Granularité disponible | 1 série globale (la fonction n'expose pas le per-orch) | 1 globale (60 pts) **et** 1 par orch (8 pts) — utile pour PER-TEAM |

### 4.2 Décision : **S4 par défaut** pour MESSAGE FLOW

Raisons :

1. **Déjà livré et testé** (`messageStats.ts` + `messageStats.test.ts`).
2. **Couplage minimal** : pas de nouveau hook réseau, pas de gestion d'erreur
   supplémentaire pour `/metrics/messages` qui pourrait échouer (token
   expiré, serveur restart…).
3. **Cohérence visuelle** : le total réagit en moins de 3 s à un événement
   (un broadcast humain bumps `msgCount` instantanément), le sparkline se
   construit au rythme attendu.

### 4.3 Comment basculer sur S9

On garde la possibilité dans `LeftPanel.tsx` via un flag (compile-time ou
état). Le pattern recommandé : **un sous-hook unifié** qui choisit la source
en fonction d'une option, et qui expose la même interface
`{ total, perMinute, history }`.

```ts
// packages/web/src/lib/leftPanelAdapters.ts (suite)

import {
  useGlobalMessageStats, type GlobalMessageStats,
} from './messageStats';
import { api, type OrchestratorView,
  type MessagesMetricsSnapshot } from '../api/client';
import { useEffect, useRef, useState } from 'react';

export type MessageFlowSource = 's4-client' | 's9-server';

/** Lit `/metrics/messages` toutes les `intervalMs` ms. Tolère 401/404/500
 *  (renvoie le dernier snapshot OK ou null). */
export function useServerMessagesMetrics(
  intervalMs: number = 60_000,
): MessagesMetricsSnapshot | null {
  const [snap, setSnap] = useState<MessagesMetricsSnapshot | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    const fetchOnce = async () => {
      try {
        const s = await api.getMetricsMessages();
        if (!cancelledRef.current) setSnap(s);
      } catch {
        /* keep previous snap, transient errors OK */
      }
    };
    void fetchOnce();
    const t = setInterval(() => void fetchOnce(), intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(t);
    };
  }, [intervalMs]);
  return snap;
}

/** Hook unifié — sélectionne la source de MESSAGE FLOW. */
export function useMessageFlow(
  orchestrators: readonly OrchestratorView[],
  source: MessageFlowSource = 's4-client',
): GlobalMessageStats {
  const s4 = useGlobalMessageStats(orchestrators);
  const s9 = useServerMessagesMetrics();
  if (source === 's9-server' && s9) {
    return {
      total: s9.total,
      perMinute: s9.per_minute,
      history: s9.global,
    };
  }
  return s4;
}
```

> Les deux hooks sont **toujours montés** (règles des hooks React — pas de
> conditionnel d'appel). Le coût en S4-only est nul puisque
> `useServerMessagesMetrics` poll en arrière-plan, mais ne consomme rien si
> on ignore son retour. Si on veut **vraiment** éviter le GET inutile,
> séparer en deux composants `LeftPanelClientFlow` /
> `LeftPanelServerFlow` montés alternativement. Premier niveau d'optimisation
> qui n'a pas lieu d'être en v1.

Pour passer en S9 : changer une seule prop dans `DesktopShell` :

```tsx
<LeftPanel … messageFlowSource="s9-server" />
```

ou exposer un toggle (settings drawer) en v2. Documenter dans le plan.

---

## 5. Composant `LeftPanel.tsx` complet

Le composant ci-dessous **remplace intégralement** le squelette de Step 2
(cf. `02_desktop-skeleton.md` §3.11). Différences-clés :

- Reçoit **`orchestrators: OrchestratorView[]`** brut (au lieu de `teams`
  pré-mâché) — il fait ses propres adaptations et possède ses propres polls.
- Reçoit `messageFlowSource` optionnel pour basculer S4/S9.
- Reçoit `onSelectTeam(sessionId)` / `onSelectEnded(orchId)` callbacks
  routing (le clic ended → route `#/orchestrators/:id` avec composer
  read-only — voir §7).
- `BUS HEALTH` poll toutes les 3 s (cf. plan §3.2).
- `useNow(30_000)` (re-render) pour rafraîchir les `formatRelative` des
  ended rows (sans, "5s ago" resterait gelé).

```tsx
// packages/web/src/components/desktop/LeftPanel.tsx

import { useEffect, useRef, useState } from 'react';
import Sparkline from './Sparkline';
import BigGraph from './BigGraph';
import { formatRelative } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import {
  api, type OrchestratorView, type BusMetricsSnapshot,
} from '../../api/client';
import {
  filterActive, filterEnded, toLeftPanelEnded,
  useMessageFlow, useServerMessagesMetrics,
  type MessageFlowSource,
  ENDED_DISPLAY_CAP,
} from '../../lib/leftPanelAdapters';

interface Props {
  orchestrators: readonly OrchestratorView[];
  /** Hash sync : sélection d'une team active (passe sessionId du lead). */
  onSelectTeam: (sessionId: string) => void;
  /**
   * Drilldown d'une team terminée. Le `DesktopShell` route
   * `#/orchestrators/:id` et propage un flag `readOnly` au RightPanel
   * (composer disabled — cf. §7).
   */
  onSelectEnded: (orchestratorId: string) => void;
  /** Bascule S4 ↔ S9 ; defaults à 's4-client' (cf. §4). */
  messageFlowSource?: MessageFlowSource;
}

export default function LeftPanel({
  orchestrators, onSelectTeam, onSelectEnded,
  messageFlowSource = 's4-client',
}: Props) {
  // ------ section MESSAGE FLOW (S4 par défaut, S9 si demandé) -----
  const flow = useMessageFlow(orchestrators, messageFlowSource);

  // ------ section PER-TEAM TRAFFIC (sparkline = S9 per-orch) ------
  // Quelle que soit la source MESSAGE FLOW, les sparklines per-team
  // utilisent S9 (S4 ne l'expose pas).
  const serverMsgs = useServerMessagesMetrics();
  const perOrchSparks = serverMsgs?.per_orchestrator ?? null;

  const activeTeams = filterActive(orchestrators);
  const ended = filterEnded(orchestrators).slice(0, ENDED_DISPLAY_CAP);

  // Re-render toutes les 30 s pour rafraîchir "Ns ago" / "Nm ago".
  // Pas besoin de stocker la valeur, l'effet de bord du hook suffit.
  useNow(30_000);

  // ------ section BUS HEALTH (S8, 3 s) -----
  const busHealth = useBusHealth(3_000);

  return (
    <aside className="panel-left">
      {/* ============ MESSAGE FLOW ============ */}
      <div className="pl-section">
        <h3>MESSAGE FLOW <span className="tag">// LIVE</span></h3>
        <div className="big-number">
          {flow.total.toLocaleString()}
          <span className="delta">+{flow.perMinute}/min</span>
        </div>
        <div className="big-sub">TOTAL EXCHANGED · LAST 60 MIN</div>
        <div className="graph"><BigGraph data={flow.history} /></div>
      </div>

      {/* ============ PER-TEAM TRAFFIC ============ */}
      <div className="pl-section grow">
        <h3>PER-TEAM TRAFFIC <span className="count">{activeTeams.length}</span></h3>
        <div className="team-list">
          {activeTeams.map((orch) => {
            const offline =
              orch.health === 'stopped' ||
              orch.status === 'stopped' ||
              orch.status === 'failed';
            const tag =
              orch.status === 'starting'
                ? 'STARTING'
                : offline
                  ? 'OFFLINE'
                  : 'ONLINE';
            const sparkColor = offline ? '#5a4d3f' : 'var(--amber)';
            const spark = perOrchSparks?.[orch.id] ?? [];
            const workers = Math.max(0, orch.sessions.length - 1);
            const purpose = (orch.role || '—').toUpperCase().slice(0, 16);
            const targetSessionId = orch.leadSessionId ?? orch.id;
            return (
              <div
                key={orch.id}
                className="team-row"
                onClick={() => onSelectTeam(targetSessionId)}
              >
                <div className="tr-name">
                  <span className="swatch" style={{ background: sparkColor }} />
                  {orch.name}
                </div>
                <div className="tr-count">{(orch.msgCount ?? 0).toLocaleString()}</div>
                <div className="tr-meta">
                  <span>{purpose}</span>
                  <span>·</span>
                  <span>{1 + workers} AGT</span>
                  <span>·</span>
                  <span
                    style={{
                      color: offline
                        ? 'var(--text-mute)'
                        : tag === 'STARTING'
                          ? 'var(--amber-soft)'
                          : 'var(--ok)',
                    }}
                  >
                    {tag}
                  </span>
                </div>
                <div className="tr-spark">
                  <Sparkline values={spark} color={sparkColor} />
                </div>
              </div>
            );
          })}
          {activeTeams.length === 0 && (
            <div style={{
              color: 'var(--text-mute)',
              fontFamily: 'Geist Mono, monospace',
              fontSize: 10,
              padding: '8px 0',
            }}>
              — no active teams —
            </div>
          )}
        </div>
      </div>

      {/* ============ RECENTLY ENDED (conditionnel) ============ */}
      {ended.length > 0 && (
        <div className="pl-section cap">
          <h3>RECENTLY ENDED <span className="count">{ended.length}</span></h3>
          <div className="team-list">
            {ended.map((orch) => {
              const e = toLeftPanelEnded(orch);
              return (
                <div
                  key={e.id}
                  className="ended-row"
                  onClick={() => onSelectEnded(orch.id)}
                >
                  <div className="ended-name">{e.name}</div>
                  <div className="ended-time">{formatRelative(e.endedAt)}</div>
                  <div className="ended-meta">
                    <span>{e.purpose}</span>
                    <span>·</span>
                    <span>{e.agentCount} AGT</span>
                    <span style={{ flex: 1 }} />
                    <span className={`badge-reason ${e.reason}`}>
                      {e.reason.toUpperCase()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ============ BUS HEALTH (S8, refresh 3 s) ============ */}
      <div className="pl-section">
        <h3>BUS HEALTH</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            fontFamily: 'Geist Mono, monospace',
            fontSize: 10,
            letterSpacing: '0.10em',
          }}
        >
          <BusHealthCell
            label="LATENCY"
            value={busHealth?.latency_ms}
            suffix="ms"
            decimals={0}
          />
          <BusHealthCell
            label="THROUGHPUT"
            value={busHealth?.throughput_msg_per_s}
            suffix="/s"
            decimals={1}
          />
          <BusHealthCell
            label="QUEUE"
            value={busHealth?.queue_depth}
            decimals={0}
          />
          <BusHealthCell
            label="ERR RATE"
            value={busHealth?.err_rate_pct}
            suffix="%"
            decimals={1}
            warnColor
          />
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Helpers internes (peuvent être ré-extraits dans un fichier utils si réusés)
// ---------------------------------------------------------------------------

function BusHealthCell({
  label, value, suffix, decimals = 0, warnColor = false,
}: {
  label: string;
  value: number | undefined;
  suffix?: string;
  decimals?: number;
  warnColor?: boolean;
}) {
  const formatted = value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(decimals);
  return (
    <div>
      <div style={{ color: 'var(--text-mute)' }}>{label}</div>
      <div
        style={{
          color: warnColor && Number(formatted) > 0 ? 'var(--warn)' : 'var(--text)',
          fontSize: 14,
          marginTop: 2,
        }}
      >
        {formatted}
        {suffix && (
          <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>{suffix}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Poll `/metrics/bus` toutes les `intervalMs` ms. Renvoie le dernier snapshot
 * connu, ou `null` tant qu'aucune réponse n'est arrivée. Tolère les erreurs
 * (404 si serveur sans BusMetricsCollector, 401 token expiré, etc.) — les
 * cellules restent à `—`.
 *
 * Placé inline dans `LeftPanel.tsx` (utilisé qu'ici). Si un autre composant en
 * a besoin un jour, sortir dans `lib/`.
 */
function useBusHealth(intervalMs: number): BusMetricsSnapshot | null {
  const [snap, setSnap] = useState<BusMetricsSnapshot | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    const fetchOnce = async () => {
      try {
        const s = await api.getMetricsBus();
        if (!cancelledRef.current) setSnap(s);
      } catch {
        /* keep previous, transient errors OK */
      }
    };
    void fetchOnce();
    const t = setInterval(() => void fetchOnce(), intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(t);
    };
  }, [intervalMs]);
  return snap;
}
```

> NB sur la signature des props : on retire `teams`, `ended`, `history`,
> `totalMessages`, `deltaPerMin`, `busHealth` (props synthétiques de Step 2)
> et on les remplace par `orchestrators` + `messageFlowSource`. C'est un
> **breaking change** du contrat public de Step 2, mais ce composant n'est
> pas encore consommé ailleurs (Step 3 ne le monte pas ; le `DesktopShell`
> placeholder rend `LeftPanel TODO`). Ajuster en même temps le call-site dans
> `DesktopShell.tsx`.

---

## 6. `BigGraph` + `Sparkline` — alimentation

Les deux composants sont déjà créés en Step 2 (voir `02_desktop-skeleton.md`
§3.9 et §3.10). **Aucun changement** n'est requis sur leur signature ; on
documente juste comment on les nourrit.

### 6.1 `BigGraph` (MESSAGE FLOW)

- Prop : `data: readonly number[]`.
- Alimentation : `flow.history` (60 entrées, voir `useGlobalMessageStats`).
- Normalisation : interne au composant — `max = Math.max(...data, 1)` (la
  ligne reste à plat quand toutes les valeurs sont 0, pas de division par
  zéro). Le 1er minute après mount, `history = [0,0,…,0]` → graphe vide
  mais valide (le `<path>` est rendu à `y = 100` partout).
- Le `useGlobalMessageStats` garantit `history.length === 60` (cf.
  `messageStats.ts:73-78`). Le composant suppose `>= 1` point ; vérifier
  qu'on ne passe jamais `[]` (S4 ne le fait pas).

### 6.2 `Sparkline` (PER-TEAM TRAFFIC)

- Prop : `values: readonly number[]` (+ couleur).
- Alimentation : `perOrchSparks?.[orch.id] ?? []`.
- Cas `[]` : le composant retourne `null` (cf. `Sparkline.tsx:16`). La cell
  reste vide, ce qui est OK visuellement (la ligne ne se dessine pas).
- Cas `[0,…,0]` : le `max = 1`, le `min = 0`, la ligne se dessine à
  `y = h` (plat en bas). Visuellement, on voit le baseline ambré.
- Normalisation interne : `range = max - min || 1` — pas de division par
  zéro.
- Le `perOrchSparks` peut être `undefined` au premier rendu (`useServerMessagesMetrics`
  n'a pas encore résolu) → on tombe sur `?? []` → null render. Acceptable.

### 6.3 Cohérence des cadences

| Composant | Donnée | Cadence d'update du UI | Cadence d'update de la donnée |
|---|---|---|---|
| `BigGraph` | `flow.history` (S4) | re-render à chaque changement de `useState` (60 s) | tick 60 s côté client |
| `Sparkline` per-team | `perOrchSparks[id]` (S9) | re-render à chaque retour du GET (60 s) | tick 60 s côté serveur |
| big number `flow.total` | sum côté client | à chaque poll `useOrchestrators` (3 s) | en temps réel sur le serveur |

Ce déséquilibre est volontaire : le nombre est en quasi-temps-réel, la
courbe se construit au pas de minute (sinon trop bruitée).

---

## 7. Click handlers

### 7.1 PER-TEAM TRAFFIC → sélection team active

- `onSelectTeam(targetSessionId)` reçoit le **sessionId du lead** (utile pour
  `DesktopShell.selectedSessionId`).
- Le `DesktopShell` :
  1. met à jour `selectedSessionId` local,
  2. appelle son `onOpenOrchestrator(orch.id)` (cf. Step 3 §6.3) → `App`
     pousse la route `#/orchestrators/:id`.

```tsx
// Extrait DesktopShell.tsx (référence — pas à éditer en step 5)
<LeftPanel
  orchestrators={orchestrators}
  onSelectTeam={(sessionId) => {
    setSelectedSessionId(sessionId);
    const orch = orchestrators.find((o) => o.leadSessionId === sessionId);
    if (orch) onOpenOrchestrator(orch.id);
  }}
  …
/>
```

### 7.2 RECENTLY ENDED → drilldown read-only

- `onSelectEnded(orchestratorId)` reçoit l'`OrchestratorView.id` directement
  (pas un sessionId — la team est terminée, le `leadSessionId` peut être
  null ou pointer vers une session `exited`).
- Le `DesktopShell` :
  1. appelle `onOpenOrchestrator(orchestratorId)` → route
     `#/orchestrators/:id`,
  2. la pré-sélection du lead (Step 3 §6.1) sélectionne automatiquement le
     lead session si dispo,
  3. le `RightPanel` détecte `orch.endedAt != null` et **passe son composer
     en `disabled`** + `placeholder = "agent stopped — reactivate to send"`
     (logique déjà prévue dans le proto v2, `panels.jsx:457`,
     `disabled={stopped}`).

```tsx
// Extrait DesktopShell.tsx (référence)
<LeftPanel
  orchestrators={orchestrators}
  onSelectEnded={(orchId) => {
    onOpenOrchestrator(orchId); // hash → #/orchestrators/:id
    // selectedSessionId sera ré-aligné par l'effet de Step 3 §6.1
  }}
  …
/>
```

### 7.3 Propagation du flag `readOnly`

Le `RightPanel.tsx` (Step B.7) doit déjà recevoir le `team: OrchestratorView`
courant. Il dérive **localement** `readOnly = team.endedAt != null` et passe
le booléen au `Composer` :

```tsx
// Future Step B.7 — pour mémoire, hors step 5
const readOnly = team.endedAt != null;
<Composer … stopped={readOnly || stoppedFromStatus} … />
```

Aucune nouvelle prop n'est strictement nécessaire pour Step 5 : le composer
read-only se déduit du `team.endedAt`. Le rôle du click ended est juste de
**naviguer** vers la team — le RightPanel s'occupe du reste.

### 7.4 Effets de bord à éviter

- Ne pas appeler `setHash` directement depuis le `LeftPanel` : le routing est
  centralisé dans `App.tsx` (Step 3). Le `LeftPanel` n'a connaissance que des
  callbacks reçus en props.
- Ne pas re-poll `useOrchestrators()` localement : le `DesktopShell` le poll
  une fois et passe la liste. Évite N×3s de bande passante.

---

## 8. Plan d'implémentation pas-à-pas

> Pré-requis : Step 2 `LeftPanel.tsx` squelette + `BigGraph.tsx` +
> `Sparkline.tsx` doivent exister sur disque (à créer en parallèle si
> jamais Step 2 n'a pas encore été exécuté — voir Skeleton doc).

1. **Augmenter `api/client.ts`** (10 lignes) :
   - Ajouter les interfaces `MessagesMetricsSnapshot` et `BusMetricsSnapshot`
     (signatures recopiées de §2.2).
   - Ajouter les méthodes `getMetricsMessages` et `getMetricsBus` dans l'objet
     `api`.
2. **Créer `packages/web/src/lib/format.ts`** si manquant (cf. Step 2 §3.2)
   pour exposer `formatRelative`. Si déjà présent → vérifier qu'il expose
   `formatRelative` et `formatClockShort`.
3. **Créer `packages/web/src/lib/leftPanelAdapters.ts`** avec :
   - `deriveTag`, `derivePurpose`, `toLeftPanelTeam`, `toLeftPanelEnded`,
     `filterActive`, `filterEnded`, `ENDED_DISPLAY_CAP` (§3).
   - `useServerMessagesMetrics`, `useMessageFlow` (§4).
4. **Réécrire `packages/web/src/components/desktop/LeftPanel.tsx`** selon le
   code de §5 :
   - Supprimer l'ancien contrat de props (`teams`, `ended`, `history`,
     `totalMessages`, `deltaPerMin`, `busHealth`).
   - Nouveau contrat : `{ orchestrators, onSelectTeam, onSelectEnded,
     messageFlowSource? }`.
   - Inclure le `useBusHealth` interne (3 s polling, tolérant aux erreurs).
   - Inclure le `BusHealthCell` helper interne.
5. **Mettre à jour `DesktopShell.tsx`** pour appeler le nouveau `LeftPanel` :
   - Lui passer `orchestrators` (déjà disponible via `useOrchestrators()`).
   - Lui passer les callbacks `onSelectTeam` et `onSelectEnded`.
   - **Si** le `DesktopShell` n'a pas encore son layout grid B.4 (TopBar /
     MapView / RightPanel), garder le placeholder de Step 3 §6.1 mais
     remplacer le `<aside>LeftPanel TODO</aside>` par le composant câblé.
6. **CSS** : aucun ajout requis — toutes les classes (`pl-section`, `tag`,
   `big-number`, `delta`, `team-list`, `team-row`, `tr-spark`, `ended-row`,
   `badge-reason exited`, `.badge-reason killed`, `.badge-reason failed`,
   `.badge-reason server-restart`) sont déjà fournies par Step A.1
   (`src/styles/desktop-theme.css`). À vérifier ; si une classe manque, la
   reporter au fichier de design.
7. **Typecheck + build** :
   ```
   pnpm --filter @swarm-os/web typecheck
   pnpm --filter @swarm-os/web build
   ```
   Aucune erreur attendue. Surveiller en particulier la nullabilité de
   `orch.leadSessionId` et `orch.endedAt` (déjà `string | null`).
8. **Tests unitaires (`vitest`)** — voir §9.
9. **Smoke manuel** (dev server + backend live) :
   ```
   pnpm --filter @swarm-os/web dev
   # ouvrir http://localhost:5173/#/
   ```
   Avec un backend qui tourne (cf. docker workflow utilisateur :
   `docker build -t swarm-os:latest . && docker compose -f docker-compose.test.yml up -d`).
10. **Docker redeploy** si on veut tester contre l'image (cf. mémoire
    utilisateur `project_docker_redeploy.md`).

---

## 9. Tests de fumée (Vitest)

Tous dans `packages/web/src/lib/leftPanelAdapters.test.ts` (purs) et
`packages/web/src/components/desktop/LeftPanel.test.tsx` (rendu).

### 9.1 Tests des adapters (purs, rapides)

```ts
// packages/web/src/lib/leftPanelAdapters.test.ts
import { describe, it, expect } from 'vitest';
import {
  deriveTag, derivePurpose, filterActive, filterEnded,
  toLeftPanelEnded,
} from './leftPanelAdapters';
import type { OrchestratorView } from '../api/client';

const baseOrch: OrchestratorView = {
  id: 'orch-1',
  name: 'TEAM-A',
  role: 'RESEARCHER',
  roleId: null,
  status: 'running',
  leadSessionId: 'sess-lead-1',
  defaultModel: 'claude-opus-4-7',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  leadPreamble: null,
  workerPreamble: null,
  createdAt: '2026-05-22T10:00:00Z',
  endedAt: null,
  lastError: null,
  sessions: [],
  msgCount: 42,
  stopReason: null,
  health: 'ok',
};

describe('deriveTag', () => {
  it('returns ONLINE for healthy running orchestrator', () => {
    expect(deriveTag(baseOrch)).toBe('ONLINE');
  });
  it('returns STARTING when status=starting', () => {
    expect(deriveTag({ ...baseOrch, status: 'starting' })).toBe('STARTING');
  });
  it('returns OFFLINE when health=stopped', () => {
    expect(deriveTag({ ...baseOrch, health: 'stopped' })).toBe('OFFLINE');
  });
  it('returns OFFLINE for status=failed regardless of health', () => {
    expect(deriveTag({ ...baseOrch, status: 'failed', health: 'bad' })).toBe('OFFLINE');
  });
  it('returns OFFLINE for status=stopping (graceful shutdown)', () => {
    expect(deriveTag({ ...baseOrch, status: 'stopping' })).toBe('OFFLINE');
  });
});

describe('derivePurpose', () => {
  it('uppercases the role', () => {
    expect(derivePurpose(baseOrch)).toBe('RESEARCHER');
  });
  it('truncates long roles', () => {
    expect(derivePurpose({ ...baseOrch, role: 'VERY-LONG-CUSTOM-ROLE' }))
      .toMatch(/^.{1,16}$/);
    expect(derivePurpose({ ...baseOrch, role: 'VERY-LONG-CUSTOM-ROLE' }))
      .toContain('…');
  });
  it('falls back to em-dash when role is empty', () => {
    expect(derivePurpose({ ...baseOrch, role: '' })).toBe('—');
  });
});

describe('filterActive / filterEnded', () => {
  const a = { ...baseOrch, id: 'a', endedAt: null };
  const b = { ...baseOrch, id: 'b', endedAt: '2026-05-22T09:00:00Z' };
  const c = { ...baseOrch, id: 'c', endedAt: '2026-05-22T09:30:00Z' };
  const list = [a, b, c];

  it('filterActive keeps endedAt == null', () => {
    expect(filterActive(list).map((o) => o.id)).toEqual(['a']);
  });
  it('filterEnded keeps endedAt != null', () => {
    expect(filterEnded(list).map((o) => o.id)).toContain('b');
    expect(filterEnded(list).map((o) => o.id)).toContain('c');
  });
  it('filterEnded sorts desc on endedAt', () => {
    expect(filterEnded(list).map((o) => o.id)).toEqual(['c', 'b']);
  });
});

describe('toLeftPanelEnded', () => {
  it('uses stopReason when present', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      stopReason: 'server-restart',
    });
    expect(e.reason).toBe('server-restart');
  });
  it('falls back to "failed" when status=failed and no stopReason', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      status: 'failed',
      stopReason: null,
    });
    expect(e.reason).toBe('failed');
  });
  it('falls back to "exited" otherwise', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      status: 'stopped',
      stopReason: null,
    });
    expect(e.reason).toBe('exited');
  });
  it('lower-cases stopReason for CSS class consistency', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      stopReason: 'KILLED',
    });
    expect(e.reason).toBe('killed');
  });
});
```

### 9.2 Tests de rendu (`React Testing Library`)

```tsx
// packages/web/src/components/desktop/LeftPanel.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LeftPanel from './LeftPanel';
import type { OrchestratorView } from '../../api/client';
import * as apiModule from '../../api/client';

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof apiModule>('../../api/client');
  return {
    ...actual,
    api: {
      ...actual.api,
      getMetricsMessages: vi.fn(async () => ({
        total: 1000,
        per_minute: 12,
        global: new Array(60).fill(0),
        per_orchestrator: { 'orch-1': [0, 0, 1, 2, 3, 4, 5, 6] },
      })),
      getMetricsBus: vi.fn(async () => ({
        latency_ms: 42,
        throughput_msg_per_s: 1.2,
        queue_depth: 7,
        err_rate_pct: 0.5,
        window_seconds: 60,
      })),
    },
  };
});

const mkOrch = (over: Partial<OrchestratorView> = {}): OrchestratorView => ({
  id: 'orch-1',
  name: 'TEAM-A',
  role: 'RESEARCHER',
  roleId: null,
  status: 'running',
  leadSessionId: 'sess-lead-1',
  defaultModel: 'claude-opus-4-7',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  leadPreamble: null,
  workerPreamble: null,
  createdAt: '2026-05-22T10:00:00Z',
  endedAt: null,
  lastError: null,
  sessions: [
    { id: 'sess-lead-1', type: 'lead' } as never,
    { id: 'sess-w-1', type: 'worker' } as never,
  ],
  msgCount: 42,
  stopReason: null,
  health: 'ok',
  ...over,
});

describe('LeftPanel rendering (smoke)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the 4 sections with one active team', () => {
    const onSelectTeam = vi.fn();
    const onSelectEnded = vi.fn();
    render(
      <LeftPanel
        orchestrators={[mkOrch()]}
        onSelectTeam={onSelectTeam}
        onSelectEnded={onSelectEnded}
      />,
    );
    expect(screen.getByText(/MESSAGE FLOW/i)).toBeInTheDocument();
    expect(screen.getByText(/PER-TEAM TRAFFIC/i)).toBeInTheDocument();
    expect(screen.getByText(/BUS HEALTH/i)).toBeInTheDocument();
    // RECENTLY ENDED absente si aucun ended
    expect(screen.queryByText(/RECENTLY ENDED/i)).toBeNull();
    // Team active présente
    expect(screen.getByText('TEAM-A')).toBeInTheDocument();
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
  });

  it('renders RECENTLY ENDED when an orchestrator has endedAt', () => {
    render(
      <LeftPanel
        orchestrators={[
          mkOrch({ endedAt: '2026-05-22T09:00:00Z', stopReason: 'killed' }),
        ]}
        onSelectTeam={vi.fn()}
        onSelectEnded={vi.fn()}
      />,
    );
    expect(screen.getByText(/RECENTLY ENDED/i)).toBeInTheDocument();
    expect(screen.getByText(/KILLED/)).toBeInTheDocument();
  });

  it('invokes onSelectTeam with the lead sessionId on row click', () => {
    const onSelectTeam = vi.fn();
    render(
      <LeftPanel
        orchestrators={[mkOrch()]}
        onSelectTeam={onSelectTeam}
        onSelectEnded={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('TEAM-A'));
    expect(onSelectTeam).toHaveBeenCalledWith('sess-lead-1');
  });

  it('invokes onSelectEnded with the orchestratorId on ended row click', () => {
    const onSelectEnded = vi.fn();
    render(
      <LeftPanel
        orchestrators={[
          mkOrch({ id: 'orch-ended', endedAt: '2026-05-22T09:00:00Z' }),
        ]}
        onSelectTeam={vi.fn()}
        onSelectEnded={onSelectEnded}
      />,
    );
    // Le texte cliquable est la ligne ended-row entière ; on cible le name
    fireEvent.click(screen.getByText('TEAM-A'));
    expect(onSelectEnded).toHaveBeenCalledWith('orch-ended');
  });

  it('renders OFFLINE tag and muted swatch when health=stopped', () => {
    render(
      <LeftPanel
        orchestrators={[mkOrch({ health: 'stopped', status: 'stopped' })]}
        onSelectTeam={vi.fn()}
        onSelectEnded={vi.fn()}
      />,
    );
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
  });

  it('renders "no active teams" when orchestrators is empty', () => {
    render(
      <LeftPanel
        orchestrators={[]}
        onSelectTeam={vi.fn()}
        onSelectEnded={vi.fn()}
      />,
    );
    expect(screen.getByText(/no active teams/i)).toBeInTheDocument();
  });
});
```

### 9.3 Vérifications manuelles (à faire avec un backend live)

| Vérification | Comment | Attendu |
|---|---|---|
| MESSAGE FLOW total | créer 1 broadcast humain via UI ou `curl -X POST /orchestrators/:id/broadcast` | `total` incrémenté ≤ 3 s plus tard ; `+N/min` reste à 0 jusqu'à la prochaine borne 60 s |
| BigGraph sparkline | laisser 5 minutes avec trafic régulier | la dernière barre s'élève ; les 55 premières restent à 0 (history fresh) |
| PER-TEAM TRAFFIC sparkline | broadcast à `orch-X` puis attendre 60 s | la sparkline de `orch-X` s'élève d'un point ; les autres restent plates |
| RECENTLY ENDED | `DELETE /orchestrators/:id` puis attendre 3 s | une ended-row apparaît avec badge `EXITED` (ou `KILLED` selon le stopReason) |
| RECENTLY ENDED — sort | terminer 3 teams espacées de 5 s | l'ordre dans la liste est le plus-récent-en-haut |
| RECENTLY ENDED — formatRelative | observer pendant 1 min | "5s ago" → "30s ago" → "1m ago" (rafraîchi par `useNow(30_000)`) |
| BUS HEALTH | tirer 100 messages en 10 s | `THROUGHPUT` >= 10/s ; `QUEUE` non nul ; `LATENCY` borné |
| BUS HEALTH — server sans collector | démarrer le serveur sans `BusMetricsCollector` | les 4 cellules restent à `—`, pas de crash console |
| Click ended → composer disabled | cliquer une ended-row | route `#/orchestrators/:id` ; RightPanel ouvert ; textarea `disabled`, send button `disabled` |
| Bascule S4 → S9 | monter `<LeftPanel messageFlowSource="s9-server" … />` dans `DesktopShell` | `total` et `+N/min` strictement issus du serveur (cohérent multi-clients) |

### 9.4 Notes d'observabilité

- Aucun `console.error` ne doit apparaître dans la console navigateur, y
  compris lors de la première seconde où `useBusHealth` n'a pas encore résolu
  (le `try/catch` swallow les erreurs réseau).
- Le `useServerMessagesMetrics` swallow aussi — si on veut un log dev, ajouter
  un `console.debug` derrière un flag `import.meta.env.DEV`.

---

## 10. Récapitulatif des fichiers touchés

| Fichier | Action | Lignes approx. |
|---|---|---|
| `packages/web/src/api/client.ts` | + 2 interfaces, + 2 méthodes `api.getMetrics*` | +20 |
| `packages/web/src/lib/format.ts` | créer si absent (cf. Step 2) — expose `formatRelative` | +50 (ou 0 si déjà créé) |
| `packages/web/src/lib/leftPanelAdapters.ts` | **nouveau** — transformateurs + hook unifié S4/S9 + hook server polling | +120 |
| `packages/web/src/components/desktop/LeftPanel.tsx` | **réécrit** — nouveau contrat de props, polling local | +200 |
| `packages/web/src/components/desktop/DesktopShell.tsx` | ajuster le call-site de `LeftPanel` (nouveau contrat) | +5 |
| `packages/web/src/lib/leftPanelAdapters.test.ts` | **nouveau** | +100 |
| `packages/web/src/components/desktop/LeftPanel.test.tsx` | **nouveau** | +120 |

Aucun changement serveur. Aucune migration de DB.

---

## 11. Risques & points d'attention

1. **Hook `useGlobalMessageStats`** garantit `history.length === 60`. Si on
   bascule sur S9 et que le serveur a tourné moins de 60 minutes, `global`
   est aussi 60 entrées (pré-alloué à 0 — cf. `aggregator.ts:56`). Pas de
   gestion spéciale requise.
2. **`per_orchestrator` peut être vide** pour un orch qui vient juste d'être
   créé (le ring est alloué au premier tick après création). Le `?? []`
   gère ce cas — Sparkline retourne `null`, la cell reste vide.
3. **`stopReason`** existe sur `OrchestratorView` (cf. `api/client.ts:38`)
   mais reste `string | null | undefined` ; le `?? fallbackReason` couvre
   les trois cas.
4. **Couleur OFFLINE vs CSS** : le proto v2 utilise `var(--text-mute)` pour
   le tag offline ; vérifier que cette variable existe bien dans
   `src/styles/desktop-theme.css` (livré en Step A.1). Sinon, fallback à
   `#b6a48b`.
5. **Cap `ENDED_DISPLAY_CAP = 20`** : si l'opérateur a besoin de voir
   l'historique complet, ajouter dans une v2 un "+ N older" lien vers une
   page dédiée. Hors scope.
6. **Polling overhead** : 3 hooks de polling parallèles (`useOrchestrators` 3 s
   au niveau `DesktopShell`, `useServerMessagesMetrics` 60 s, `useBusHealth`
   3 s). Avec `useGlobalMessageStats` qui tick aussi à 60 s, soit ~21 req/min.
   Acceptable. Si l'opérateur a 5 onglets ouverts, ×5 = ~100 req/min, encore
   OK pour le serveur (les endpoints metrics sont O(N) avec N orchs).
7. **Hooks toujours montés (§4.3)** : `useServerMessagesMetrics` est appelé
   dans `LeftPanel` même quand `messageFlowSource === 's4-client'` (pour
   alimenter les sparklines per-team). C'est intentionnel — un seul GET sert
   les deux usages.
8. **Robustness `Date.parse`** : `formatRelative('')` retourne `'—'` (cf.
   `format.ts` Step 2 — `if (!Number.isFinite(t)) return '—'`). Si `endedAt`
   est `null` côté UI, ne pas l'envoyer (le filtre `filterEnded` garantit
   `endedAt != null` avant rendu).

---

## 12. Critères d'acceptation step 5

- [ ] `api.getMetricsMessages()` et `api.getMetricsBus()` exportés depuis
      `api/client.ts` avec interfaces typées.
- [ ] `lib/leftPanelAdapters.ts` exporte tous les helpers documentés en §3 et
      les hooks `useServerMessagesMetrics` + `useMessageFlow` (§4).
- [ ] `LeftPanel.tsx` rend les 4 sections avec données réelles, sans mock
      `window.SPARK_DATA` (la dernière ligne du proto v2).
- [ ] Click sur une team active → callback avec `leadSessionId` correct.
- [ ] Click sur une ended → callback avec `orch.id`, RightPanel ouvert,
      composer disabled (via la logique `endedAt != null` du RightPanel).
- [ ] `messageFlowSource` prop fonctionnelle ; bascule visible en switchant
      la prop côté `DesktopShell`.
- [ ] BUS HEALTH actualise toutes les 3 s ; affiche `—` quand le serveur
      n'a pas de `BusMetricsCollector`.
- [ ] `pnpm --filter @swarm-os/web typecheck` vert.
- [ ] `pnpm --filter @swarm-os/web test` vert (8 anciens tests + 2 nouveaux
      fichiers de test).
- [ ] Aucun warning React dans la console dev (deps de hooks correctes).
- [ ] Smoke navigateur OK contre un backend live (cf. §9.3).
