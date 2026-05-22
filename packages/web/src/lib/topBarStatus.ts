// packages/web/src/lib/topBarStatus.ts
//
// Mapping orchestrator → pill visuel pour la TopBar v2 (cf.
// docs/ui-redesign-desktop.md §3.1 et docs/redesign-desktop/04_topbar-data-binding.md).
//
// Le bucket retourné pilote :
//  - la classe CSS du dot (`stopped|bad|waiting|starting|warn|ok`)
//  - le label affiché (`OFFLINE|BAD|WAITING|STARTING|DEGRADED|HEALTHY`)
//  - la largeur de la pill-bar (cf. derivePillBarPct)
//
// Cette fonction n'a pas vocation à modifier le state serveur ; elle
// dérive uniquement de `orch.status`, `orch.health` (S7), et de la liste
// `orch.sessions`. WAITING est *prioritaire* sur STARTING (un agent qui
// attend une réponse opérateur est plus urgent qu'un agent qui boote).

import type { OrchestratorView } from '../api/client';

export type PillStatus =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'WAITING'
  | 'STARTING'
  | 'OFFLINE'
  | 'BAD';

export function deriveTopBarPillStatus(orch: OrchestratorView): PillStatus {
  // 1. OFFLINE : team complètement arrêtée (S7 'stopped' couvre
  //              status ∈ {stopped, exited, killed} côté server).
  if (orch.health === 'stopped') return 'OFFLINE';

  // 2. BAD : team en échec (failed, lastError persistant).
  if (orch.health === 'bad') return 'BAD';

  // 3. WAITING : au moins une session attend un input humain. On scanne
  //              toutes les sessions (lead + workers) — un seul `waiting`
  //              suffit.
  if (orch.sessions.some((s) => s.status === 'waiting')) return 'WAITING';

  // 4. STARTING : la team est en cours de démarrage côté orchestrator-level.
  //               (On pourrait aussi regarder `sessions.some(s => s.status
  //               === 'starting')` mais `orch.status` est l'autorité S7.)
  if (orch.status === 'starting') return 'STARTING';

  // 5. DEGRADED : health server dit "warn" — au moins un signal négatif
  //               sans atteindre le seuil 'bad'.
  if (orch.health === 'warn') return 'DEGRADED';

  // 6. HEALTHY : tout va bien.
  return 'HEALTHY';
}

/**
 * Mapping pill → classe CSS du dot (warm-black theme).
 * Cf. `src/styles/desktop-theme.css` (Step 1).
 */
export function pillDotClass(p: PillStatus): string {
  switch (p) {
    case 'OFFLINE':  return 'stopped';
    case 'BAD':      return 'bad';
    case 'WAITING':  return 'waiting';
    case 'STARTING': return 'starting';
    case 'DEGRADED': return 'warn';
    case 'HEALTHY':  return 'ok';
  }
}

/**
 * Mapping pill → classe CSS de la barre de progression (pill-bar).
 * WAITING surcharge la couleur (orange pulsant).
 */
export function pillBarClass(
  p: PillStatus,
): 'stopped' | 'bad' | 'waiting' | 'warn' | 'ok' {
  switch (p) {
    case 'OFFLINE':  return 'stopped';
    case 'BAD':      return 'bad';
    case 'WAITING':  return 'waiting';
    case 'STARTING': return 'ok';       // bar verte courte le temps du boot
    case 'DEGRADED': return 'warn';
    case 'HEALTHY':  return 'ok';
  }
}

/**
 * Pourcentage de remplissage de la pill-bar.
 * - OFFLINE/BAD → 0% (barre vide)
 * - DEGRADED → 60% (warn)
 * - HEALTHY/WAITING/STARTING → 85% (ok-équivalent)
 *
 * Aligné v2 `app.jsx:82` (formule originale `health === 'warn' ? 0.6 : 0.85`).
 */
export function derivePillBarPct(p: PillStatus): number {
  if (p === 'OFFLINE' || p === 'BAD') return 0;
  if (p === 'DEGRADED') return 60;
  return 85;
}
