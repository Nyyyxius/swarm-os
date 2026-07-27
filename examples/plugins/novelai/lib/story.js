// story.js — assemble the ONE string a NovelAI text model continues.
//
// WHY THIS MODULE EXISTS. NovelAI has no "instruction" field: `/ai/generate` and
// `/oa/v1/completions` both take a single string and return its continuation.
// "Steering the story" is therefore not a parameter, it is a POSITION — the
// model weighs a line by how close it sits to the end. The whole craft is:
//
//   [ ATTG ]            genre / register, top of context
//   Memory              permanent facts, restated on EVERY call
//   ...story tail...    continuity (the head is dropped, not the tail)
//   [ Author's note ]   what must happen NOW — a few lines from the end
//   opening             a fragment cut mid-sentence, so the model continues it
//
// Documenting that in a tool description would ask every agent to redo the same
// string surgery and get it subtly wrong: a note pasted at the top is inert, a
// context truncated from the wrong end silently drops Memory, and a prompt that
// ends on a full stop invites the model to start a new chapter. Making it a
// FUNCTION means the placement cannot be got wrong at all, and the instruction
// shrinks to "your text in `story`, your direction in `authors_note`".
//
// PURE: no I/O, no clock, no randomness, no module-level mutable state (lib/
// modules survive plugin reloads — see the header of nai.js).

/** Characters of `story` kept by default. Overridden per model by the caller. */
export const DEFAULT_WINDOW_CHARS = 3000;

/** Author's note depth: it is inserted before the last N non-empty lines. */
export const DEFAULT_NOTE_DEPTH = 3;

/** Past this, a note stops being a direction and starts being competing prose. */
const NOTE_SOFT_MAX = 400;

/** Separator NovelAI's own format uses between context blocks. */
const SEP = '***';

/** Ends on sentence punctuation (optionally followed by a closing quote)? */
const ENDS_CLOSED = /[.!?…][”"'’)\]]?\s*$/;

/** Accented Latin letters — near-absent from English prose. */
const ACCENTED = /[àâäáãçéèêëíîïñóôöõùûüúÿœæ]/gi;

/**
 * Romance-language elision: a single-letter word (or `qu`) glued to the next by
 * an apostrophe — `d'or`, `l'homme`, `qu'il`. English apostrophes work the other
 * way round (`don't`, `we're`), so the leading `\b` never matches there: in
 * "don't" the `n` is not at a word boundary.
 *
 * This is the signal that survives someone typing French WITHOUT accents, which
 * is exactly how the convention gets broken in this repo.
 */
const ELISION = /\b(?:[cdjlmnst]|qu)'/gi;

/**
 * TWO SIGNALS, TWO THRESHOLDS, because they do not lie at the same rate.
 *
 * An accent is weak evidence: English borrows `déjà vu`, `café`, `naïve`, and a
 * single loanword already carries two of them. An elision is strong evidence:
 * English never writes `\bd'`, `\bl'` or `\bqu'` at all, so two of them settle
 * the question on their own — which is what catches French typed WITHOUT
 * accents, the form no accent count can see.
 *
 * Summing them under one threshold, as a first draft did, forces a choice
 * between flagging `déjà vu` and missing a French memory block. Splitting the
 * thresholds costs one line and removes the dilemma.
 */
const MIN_ACCENTS = 3;
const MIN_ELISIONS = 2;
const MIN_COMBINED = 3;

/**
 * Heuristic: does this text look like it is NOT English?
 *
 * A HEURISTIC, deliberately, and it only ever produces a warning — never a
 * refusal. It catches what matters (a context written in French) and tolerates
 * the edges: an English page quoting three accented words trips it, and a short
 * unaccented note like "Elara le confronte" slips through. Both are acceptable
 * when the output is one advisory line.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksNonEnglish(text) {
  const src = typeof text === 'string' ? text : '';
  if (src.length === 0) return false;
  const accents = (src.match(ACCENTED) || []).length;
  const elisions = (src.match(ELISION) || []).length;
  return accents >= MIN_ACCENTS || elisions >= MIN_ELISIONS || accents + elisions >= MIN_COMBINED;
}

/**
 * Keep the LAST `maxChars` of `text`, cut on a line boundary so the window never
 * opens mid-word. The HEAD is what gets dropped: the tail is the continuity the
 * model needs, and anything that must outlive the window belongs in `memory`.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {{tail: string, cut: number}} `cut` = characters dropped
 */
export function tailOf(text, maxChars) {
  const src = typeof text === 'string' ? text : '';
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_WINDOW_CHARS;
  if (src.length <= max) return { tail: src, cut: 0 };
  const slice = src.slice(src.length - max);
  const nl = slice.indexOf('\n');
  // No newline in the whole window: keep the raw slice rather than returning ''.
  const tail = nl >= 0 && nl < slice.length - 1 ? slice.slice(nl + 1) : slice;
  return { tail, cut: src.length - tail.length };
}

/**
 * Insert `block` before the last `depth` NON-EMPTY lines of `text`.
 *
 * Counting non-empty lines rather than raw lines is what makes the depth stable:
 * prose is usually double-spaced, so a raw count of 3 would land the note in the
 * middle of the blank lines instead of three paragraphs up.
 *
 * The depth is CLAMPED so at least one line of prose always precedes the block.
 * Without that clamp a story shorter than `depth` hoists the note above
 * everything — which is exactly the inert placement the note exists to avoid,
 * and it happens silently on the first few calls of every new story, when the
 * steering matters most.
 *
 * @param {string} text
 * @param {string} block already-formatted, inserted verbatim
 * @param {number} depth
 * @returns {string}
 */
export function insertAtDepth(text, block, depth) {
  const src = typeof text === 'string' ? text : '';
  const asked = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : DEFAULT_NOTE_DEPTH;
  if (src === '') return block;
  const lines = src.split('\n');
  const nonEmpty = lines.reduce((n, l) => (l.trim() !== '' ? n + 1 : n), 0);
  const want = Math.max(1, Math.min(asked, nonEmpty - 1));
  let idx = lines.length;
  let seen = 0;
  while (idx > 0 && seen < want) {
    idx -= 1;
    if (lines[idx].trim() !== '') seen += 1;
  }
  lines.splice(idx, 0, '', block, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Assemble the prompt. Never throws; every problem is reported as a WARNING
 * string rather than a rejection, because a slightly-off context still produces
 * usable prose and refusing the call would help nobody.
 *
 * @param {{
 *   story?: string,
 *   memory?: string,
 *   authorsNote?: string,
 *   attg?: string,
 *   opening?: string,
 *   windowChars?: number,
 *   noteDepth?: number,
 * }} input
 * @returns {{prompt: string, cut: number, warnings: string[]}}
 */
export function buildStoryPrompt(input) {
  const i = input || {};
  const warnings = [];

  const attg = str(i.attg);
  const memory = str(i.memory);
  const note = str(i.authorsNote);
  const opening = str(i.opening);
  const { tail, cut } = tailOf(str(i.story), i.windowChars ?? DEFAULT_WINDOW_CHARS);

  /** @type {string[]} */
  const head = [];
  // Square brackets are NovelAI's training convention for out-of-story
  // metadata. Worst case the model reads them as prose — it degrades softly.
  if (attg) head.push(attg.startsWith('[') ? attg : `[ ${attg} ]`);
  if (memory) head.push(memory);

  let body = tail;
  if (note) {
    const block = `[ Note de l'auteur : ${note} ]`;
    // Depth applies to the STORY only. With no story yet the note still has to
    // sit last, right before the opening, or it loses all its weight.
    body = tail ? insertAtDepth(tail, block, i.noteDepth ?? DEFAULT_NOTE_DEPTH) : block;
  }

  const parts = [];
  if (head.length > 0) parts.push(head.join('\n\n'), SEP);
  if (body) parts.push(body);
  let prompt = parts.join('\n\n');
  if (opening) prompt = prompt ? `${prompt}\n\n${opening}` : opening;

  // --- warnings: the pedagogy that costs nothing until it is needed ---------
  if (cut > 0) {
    warnings.push(
      `Contexte tronque : les ${cut} premiers caracteres de story ont ete coupes (la fin est conservee). ` +
        'Tout fait qui doit survivre au-dela de la fenetre appartient a memory, pas a story.',
    );
  }
  if (!note) {
    warnings.push(
      "Aucun authors_note : le modele continue sans direction et derivera vers ses propres idees. " +
        'Une phrase suffit pour cadrer le paragraphe suivant.',
    );
  } else if (note.length > NOTE_SOFT_MAX) {
    warnings.push(
      `authors_note fait ${note.length} caracteres : au-dela de ~${NOTE_SOFT_MAX} elle concurrence la prose ` +
        'au lieu de la diriger. Garde une consigne, pas un resume.',
    );
  }
  if (!memory && tail) {
    warnings.push(
      "Aucun memory : les personnages et les regles du monde sortiront de la fenetre et seront oublies. " +
        'Mets-y qui est qui, ou on est, et la voix narrative.',
    );
  }
  // Checked on the ASSEMBLED prompt, not field by field: more text means a
  // steadier verdict, and a French memory with an English story is just as
  // damaging — the model sees one string either way.
  if (looksNonEnglish(prompt)) {
    warnings.push(
      "Le contexte ne semble pas etre en anglais. Les modeles NovelAI sont entraines sur de la fiction " +
        'ANGLAISE : dans une autre langue la prose reste grammaticale mais devient plate, repetitive et ' +
        'hors registre, sans jamais lever d\'erreur. Ecris story, memory, authors_note et opening en anglais, ' +
        'puis traduis le resultat final si tu en as besoin dans une autre langue.',
    );
  }
  const endsOn = opening || prompt;
  if (!opening && ENDS_CLOSED.test(endsOn)) {
    warnings.push(
      'Le contexte se termine sur une phrase complete : le modele est libre de changer de sujet ' +
        "(voire d'ouvrir un chapitre). Passe un fragment coupe en plein milieu dans `opening`, " +
        'par exemple "Elle leva les yeux vers le messager et".',
    );
  }

  return { prompt, cut, warnings };
}

/** @param {unknown} v @returns {string} trimmed, or '' */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}
