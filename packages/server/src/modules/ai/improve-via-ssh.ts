import { spawn } from 'node:child_process';
import type { Config } from '../../config.js';
import { shellQuote } from '../orchestrator/agent-process.js';
import { withModule } from '../../logger.js';

const log = withModule('ai-improve');

export type ImproveField = 'leadPrompt' | 'leadPreamble' | 'workerPreamble';

const SYSTEM_PROMPTS: Record<ImproveField, string> = {
  leadPrompt: [
    "Tu améliores un *lead prompt* pour un rôle dans swarm-os, un orchestrateur multi-agent Claude Code.",
    "Le lead prompt est la directive initiale donnée au lead agent d'une équipe — il décrit la mission, le scope, les attentes de sortie.",
    "Réécris la version utilisateur ci-dessous pour la rendre plus claire, plus spécifique, plus actionnable.",
    "Si elle est vide, génère une ébauche raisonnable pour un rôle générique.",
    "Garde le format Markdown concis (~30 lignes max).",
    "Réponds avec UNIQUEMENT le texte amélioré, sans préambule, sans fence ```, sans commentaire.",
  ].join(' '),
  leadPreamble: [
    "Tu améliores un *lead preamble override* pour un rôle dans swarm-os.",
    "Ce texte est ajouté APRÈS le preamble canonique (qui couvre déjà mailbox, team tools, identité).",
    "L'override porte les instructions project-specific — conventions de code, layout du repo, glossaire, règles d'escalation.",
    "Réécris la version utilisateur pour la resserrer et ajouter de la structure utile.",
    "Préserve les placeholders {{name}}, {{role}}, {{sessionId}}, {{orchName}} s'ils sont présents.",
    "Ne répète PAS la discipline mailbox générique (déjà couverte upstream).",
    "Si l'entrée est vide, génère une ébauche neutre.",
    "Réponds avec UNIQUEMENT le markdown amélioré.",
  ].join(' '),
  workerPreamble: [
    "Tu améliores un *worker preamble override* pour un rôle dans swarm-os.",
    "Les workers sont des agents subordonnés spawn par le lead ; le preamble canonique couvre déjà le report-back au lead et les outils de base.",
    "L'override ajoute les instructions worker project-specific — conventions de fichiers, définition de \"done\", quand demander au lead vs décider seul.",
    "Réécris la version utilisateur pour la rendre plus serrée et plus concrète.",
    "Préserve les placeholders verbatim.",
    "Si l'entrée est vide, génère une ébauche.",
    "Réponds avec UNIQUEMENT le markdown amélioré.",
  ].join(' '),
};

function buildSshArgs(config: Config): string[] {
  if (!config.sshTarget) throw new Error('sshTarget is null');
  const muxKey = config.sshTarget.replace(/[^a-zA-Z0-9]/g, '_');
  return [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/tmp/swarm-os-known-hosts',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=/tmp/swarm-os-ssh-mux-${muxKey}.sock`,
    '-o', 'ControlPersist=600',
    '-o', 'ExitOnForwardFailure=no',
    '-i', config.sshKey,
    '-p', String(config.sshPort),
    config.sshTarget,
    '--',
    `bash -lc ${shellQuote('claude -p --model claude-opus-4-7 --output-format text')}`,
  ];
}

function stripOuterFence(text: string): string {
  const m = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  return m?.[1] ?? text;
}

export async function improveTextViaSsh(
  config: Config,
  field: ImproveField,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  if (config.agentTransport !== 'ssh' || !config.sshTarget) {
    throw new Error('AI_TRANSPORT_UNAVAILABLE');
  }
  const sshArgs = buildSshArgs(config);
  const prompt = `${SYSTEM_PROMPTS[field]}\n\n---\nUSER DRAFT:\n${text}`;

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error('AI_TIMEOUT'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.on('exit', (code, sig) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve(stripOuterFence(stdout.trim()));
      } else {
        log.warn({
          event: 'ai_improve.ssh_failed',
          field,
          exit_code: code,
          signal: sig,
          stderr_tail: stderr.slice(-500),
        });
        reject(new Error(`claude exited with code ${code}${sig ? ` (signal ${sig})` : ''}: ${stderr.slice(-500)}`));
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
