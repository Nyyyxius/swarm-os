// packages/web/src/components/TeamCostsSection.tsx
//
// TEAM COSTS — the section between the KPI band and the agent table on
// `#/monitoring` (docs/monitoring-agents.md, Lot 12).
//
// It answers the one question the table above it structurally CANNOT: what
// has this team cost me. The table renders live sessions, so its column adds
// up to the spend of the agents that happen to still exist — and on a swarm
// with `auto_remove_dead_workers` on, that can be a small fraction of the
// bill. These figures come from a SQL aggregate over the session rows, hidden
// ones included, which is what the `DB TOTALS · REMOVED WORKERS INCLUDED`
// subtitle is there to say out loud.
//
// Two levels, two very different fetch policies:
//
//   - the team lines ride on `useTeamCosts`' 15 s poll, owned by the page (it
//     also feeds the BURN /H KPI — one request, two consumers);
//   - the per-session ventilation is fetched by `TeamCostDetail` when it
//     MOUNTS, i.e. when a row is expanded, and never polled. Its subject is a
//     list of dead workers whose counters are frozen by definition.
//
// The header stays mounted even with nothing to show. A section that appears
// and disappears depending on whether the backend has the endpoint is a
// section the operator cannot learn the position of; `— no cost data yet —`
// says the same thing without moving the page around.

import { useEffect, useState } from 'react';
import {
  api, apiErrorMessage,
  type OrchestratorCostView, type TeamCostRow, type TeamCostsSnapshot,
} from '../api/client';
import {
  aggregateCostUsd, formatCostKpi, formatUsd, TOKEN_PLACEHOLDER,
} from '../lib/tokenCost';
import {
  BURN_ANOMALY_FACTOR, formatBurn, formatRemovedCell, formatSessionTokenLine,
  isBurnAnomalous, medianBurn, removedBadge, removedSessions,
  sortTeamsByCostDesc,
} from '../lib/teamCost';
import { budgetTitle, isOverBudget, OVER_BUDGET_BADGE } from '../lib/budget';

interface Props {
  /** Latest `/metrics/costs` snapshot, or `null` before the first one lands. */
  snapshot: TeamCostsSnapshot | null;
}

/** Stable empty array — a fresh `[]` per render would churn every memo. */
const NO_TEAMS: TeamCostRow[] = [];

export default function TeamCostsSection({ snapshot }: Props) {
  // Expanded by default, per the design: the whole point of the section is to
  // be read without being asked for. The fold exists for the operator who
  // runs twenty teams and wants the agent table back.
  const [folded, setFolded] = useState(false);
  const [openTeam, setOpenTeam] = useState<string | null>(null);

  const teams = snapshot?.teams ?? NO_TEAMS;
  const sorted = sortTeamsByCostDesc(teams);
  const median = medianBurn(teams);
  // Σ over the same lines the section shows, so the header can never disagree
  // with the column under it. `partial` (a team we could not price) turns it
  // into `≥`, exactly like the EST. COST KPI.
  const sum = aggregateCostUsd(teams.map((t) => t.total.costUsd));

  return (
    <section className="mon-costs" aria-label="Team costs">
      {/* The WHOLE header is the fold control — there is nothing else to
          click up here, and a 9 px triangle is a poor target. Its chevron
          sits at the far right so it lands in the same column as the per-team
          ones below, which is what makes the two levels read as one
          disclosure hierarchy rather than two unrelated widgets. */}
      <button
        type="button"
        className="mon-costs-head"
        aria-expanded={!folded}
        title={folded ? 'show team costs' : 'hide team costs'}
        onClick={() => {
          setFolded((f) => !f);
          // Folding closes the open drill-down too: leaving it armed would
          // make the next unfold re-issue a request for a panel the operator
          // has not asked for again.
          setOpenTeam(null);
        }}
      >
        <span className="mon-costs-label">TEAM COSTS</span>
        <span className="mon-costs-sub">DB TOTALS · REMOVED WORKERS INCLUDED</span>
        {/* The Σ is dropped entirely rather than shown as `Σ — EST` when
            nothing is priced: an em-dash in the place of a headline figure
            reads like a broken number, and the body already says why. */}
        {sum.total !== null && (
          <span
            className="mon-costs-sum"
            title={
              sum.partial
                ? 'lower bound — some teams report no priced spend'
                : undefined
            }
          >
            Σ {formatCostKpi(sum)} EST
          </span>
        )}
        <span className="mon-costs-chev mon-costs-chev-head">
          {folded ? '▸' : '▾'}
        </span>
      </button>

      {!folded && (
        <div className="mon-costs-body">
          {sorted.length === 0 ? (
            <div className="mon-costs-empty">— no cost data yet —</div>
          ) : (
            <>
              <div className="mon-costs-row mon-costs-cols">
                <span>TEAM</span>
                <span>AGENTS</span>
                <span className="mon-costs-num">BURN /H</span>
                <span className="mon-costs-num">TOTAL</span>
                <span>REMOVED</span>
                <span />
              </div>
              {sorted.map((t) => (
                <TeamRow
                  key={t.orchId}
                  team={t}
                  median={median}
                  open={t.orchId === openTeam}
                  onToggle={() => setOpenTeam(
                    (cur) => (cur === t.orchId ? null : t.orchId),
                  )}
                />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ── one team line, plus its drill-down ───────────────────────────────────────

interface RowProps {
  team: TeamCostRow;
  median: number | null;
  open: boolean;
  onToggle: () => void;
}

function TeamRow({ team, median, open, onToggle }: RowProps) {
  // The ONLY tinted amount on this page. Every other figure here takes a text
  // token: there is no dangerous dollar TOTAL (a long-running team is
  // supposed to have spent money), but a team burning several times what the
  // rest of the swarm burns, right now, is a fact worth catching an eye.
  const hot = isBurnAnomalous(team.burnPerHour, median);
  // Lot 14 — the server's verdict, never a client-side comparison (see
  // `isOverBudget`). A team with no budget renders exactly as it did before.
  const over = isOverBudget(team);

  return (
    <div className="mon-costs-team">
      <button
        type="button"
        className="mon-costs-row mon-costs-line"
        aria-expanded={open}
        title={open ? 'hide removed workers' : 'show removed workers'}
        onClick={onToggle}
      >
        {/* The badge rides INSIDE the first grid cell rather than beside it:
            `.mon-costs-row` is a six-track grid and a seventh child would
            silently shift every column of the header above it. */}
        <span className="mon-costs-team-cell">
          <span className="mon-costs-name">{team.name}</span>
          {over && <span className="badge-budget">{OVER_BUDGET_BADGE}</span>}
        </span>
        <span className="mon-costs-live">{team.live} LIVE</span>
        <span
          className="mon-costs-num mon-costs-burn"
          style={hot ? { color: 'var(--warn)' } : undefined}
          title={
            hot
              ? `burning more than ${BURN_ANOMALY_FACTOR}× the median team rate`
              : undefined
          }
        >
          {formatBurn(team.burnPerHour)}
        </span>
        {/* The amount itself stays untinted — the badge two cells to the left
            already carries the colour, and a red TOTAL would read as "this
            number is wrong". What the cell gains is the PAIR, on hover: the
            96 px column has no room for `$52.10 / $50.00`, and the ceiling is
            the one piece of context that makes the total mean anything. */}
        <span
          className="mon-costs-num mon-costs-total"
          title={budgetTitle(team)}
        >
          {formatUsd(team.total.costUsd) ?? TOKEN_PLACEHOLDER}
        </span>
        <span className="mon-costs-removed">{formatRemovedCell(team.removed)}</span>
        <span className="mon-costs-chev">{open ? '▾' : '▸'}</span>
      </button>
      {/* Mounting is the fetch, unmounting is the cancel — so re-expanding a
          row re-reads it rather than showing a snapshot from ten minutes ago. */}
      {open && <TeamCostDetail orchId={team.orchId} />}
    </div>
  );
}

// ── the removed workers of one team ──────────────────────────────────────────

function TeamCostDetail({ orchId }: { orchId: string }) {
  const [view, setView] = useState<OrchestratorCostView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    void (async () => {
      try {
        const v = await api.getOrchestratorCost(orchId);
        if (!cancelled) setView(v);
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, [orchId]);

  if (error !== null) {
    return (
      <div className="mon-costs-detail">
        <div className="mon-costs-state">— detail unavailable —</div>
      </div>
    );
  }
  if (view === null) {
    return (
      <div className="mon-costs-detail">
        <div className="mon-costs-state">LOADING…</div>
      </div>
    );
  }

  // Removed sessions ONLY. The live ones are in the table below, with more
  // detail and live numbers; repeating them here would make the panel a worse
  // copy of the page it sits on.
  const rows = removedSessions(view.sessions);
  if (rows.length === 0) {
    return (
      <div className="mon-costs-detail">
        <div className="mon-costs-state">— no removed workers —</div>
      </div>
    );
  }

  return (
    <div className="mon-costs-detail">
      {rows.map((s) => {
        const badge = removedBadge(s.status);
        return (
          <div className="mon-costs-sess" key={s.id}>
            <span className="mon-costs-sess-name">{s.name}</span>
            <span className={badge.cls}>{badge.label}</span>
            {s.tokens ? (
              <span className="mon-costs-sess-tok">
                {formatSessionTokenLine(s.tokens)}
              </span>
            ) : (
              // The honest half-row: this worker DID spend, we simply have no
              // counters for it (it ran before Lot 11). Zeros here would make
              // the team total look like an arithmetic error.
              <span className="mon-costs-sess-tok mon-costs-sess-nodata">
                PRE-COUNTERS SESSION — NO DATA
              </span>
            )}
            <span className="mon-costs-sess-cost">
              {formatUsd(s.costUsd) ?? TOKEN_PLACEHOLDER}
            </span>
          </div>
        );
      })}
    </div>
  );
}
