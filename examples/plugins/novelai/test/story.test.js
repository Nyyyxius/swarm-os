// Tests for `../lib/story.js` — assembling the single string NovelAI continues.
//
// This module exists so that agents do not have to perform string surgery they
// would get subtly wrong, so the tests are about POSITION and LOSS:
//
//  1. ORDER. ATTG, then memory, then the story, then the author's note, then the
//     opening. The note near the END is the entire steering mechanism — a note
//     that drifts to the top is inert and nothing else in the system notices.
//  2. THE HEAD IS DROPPED, NEVER THE TAIL. Truncating from the wrong end throws
//     away the continuity the model needs and keeps prose it has moved past.
//  3. WARNINGS ARE THE PEDAGOGY. They cost nothing until the context has a known
//     defect, and they are the only channel that speaks at the exact moment the
//     mistake is made. Each one must fire on its own trigger and stay silent
//     otherwise.
//  4. PURITY. No clock, no randomness, no module state: the same input must give
//     byte-identical output, because lib/ modules survive plugin reloads.

import { describe, it, expect } from 'vitest';

import {
  buildStoryPrompt,
  insertAtDepth,
  tailOf,
  DEFAULT_NOTE_DEPTH,
} from '../lib/story.js';

const MEMORY = 'Elara est archiviste. Cort ment sur son accent.';
const STORY = ['Elle referma le registre.', '', 'La cire etait tiede.', '', 'Neuf jours, disait le pli.'].join('\n');
const NOTE = 'Elara le confronte. Ton sec.';
const OPENING = 'Elle leva les yeux vers le messager et';

describe('tailOf — the head is what gets dropped', () => {
  it('returns the text untouched when it fits', () => {
    expect(tailOf('court', 100)).toEqual({ tail: 'court', cut: 0 });
  });

  it('keeps the END and reports how much was cut', () => {
    const text = 'a'.repeat(50) + '\n' + 'FIN';
    const { tail, cut } = tailOf(text, 10);
    expect(tail).toBe('FIN');
    expect(cut).toBe(text.length - 'FIN'.length);
  });

  it('cuts on a line boundary rather than mid-word', () => {
    const text = 'premiere ligne\ndeuxieme ligne\ntroisieme ligne';
    const { tail } = tailOf(text, 20);
    expect(tail).toBe('troisieme ligne');
    expect(text.endsWith(tail)).toBe(true);
  });

  it('falls back to the raw slice when the window holds no newline', () => {
    const { tail } = tailOf('x'.repeat(100), 10);
    expect(tail).toBe('x'.repeat(10));
  });

  it('treats a missing or absurd limit as the default rather than returning nothing', () => {
    expect(tailOf('abc', 0).tail).toBe('abc');
    expect(tailOf('abc', Number.NaN).tail).toBe('abc');
  });
});

describe('insertAtDepth — counting NON-EMPTY lines', () => {
  it('places the block before the last N non-empty lines', () => {
    const out = insertAtDepth('un\n\ndeux\n\ntrois', '[NOTE]', 1);
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toEqual(['un', 'deux', '[NOTE]', 'trois']);
  });

  it('ignores blank lines when counting, so double-spaced prose lands right', () => {
    const out = insertAtDepth('a\n\nb\n\nc\n\nd', '[NOTE]', 2);
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toEqual(['a', 'b', '[NOTE]', 'c', 'd']);
  });

  it('puts the block first when the text is shorter than the requested depth', () => {
    const out = insertAtDepth('seule ligne', '[NOTE]', 5);
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toEqual(['[NOTE]', 'seule ligne']);
  });

  it('returns the block alone for empty text', () => {
    expect(insertAtDepth('', '[NOTE]', DEFAULT_NOTE_DEPTH)).toBe('[NOTE]');
  });
});

describe('buildStoryPrompt — order is the whole mechanism', () => {
  it('lays the sections out in the order that makes the note weigh most', () => {
    const { prompt } = buildStoryPrompt({
      attg: 'Titre: X; Genre: fantasy',
      memory: MEMORY,
      story: STORY,
      authorsNote: NOTE,
      opening: OPENING,
    });

    const iAttg = prompt.indexOf('Titre: X');
    const iMemory = prompt.indexOf(MEMORY);
    const iNote = prompt.indexOf(NOTE);
    const iOpening = prompt.indexOf(OPENING);

    expect(iAttg).toBeGreaterThanOrEqual(0);
    expect(iAttg).toBeLessThan(iMemory);
    expect(iMemory).toBeLessThan(iNote);
    expect(iNote).toBeLessThan(iOpening);
    // The opening is LAST — nothing may be appended after the lead-in.
    expect(prompt.endsWith(OPENING)).toBe(true);
  });

  it('puts the note near the end of the story, not at the top', () => {
    const { prompt } = buildStoryPrompt({ memory: MEMORY, story: STORY, authorsNote: NOTE });
    const iFirstProse = prompt.indexOf('Elle referma');
    const iNote = prompt.indexOf(NOTE);
    // Strictly after the first paragraph: a note hoisted to the top is inert.
    expect(iNote).toBeGreaterThan(iFirstProse);
  });

  it('wraps a bare ATTG in brackets and leaves an already-bracketed one alone', () => {
    expect(buildStoryPrompt({ attg: 'Genre: X', story: 'a' }).prompt).toContain('[ Genre: X ]');
    expect(buildStoryPrompt({ attg: '[ Genre: X ]', story: 'a' }).prompt).toContain('[ Genre: X ]');
    expect(buildStoryPrompt({ attg: '[ Genre: X ]', story: 'a' }).prompt).not.toContain('[ [ Genre');
  });

  it('still emits the note when there is no story yet', () => {
    const { prompt } = buildStoryPrompt({ memory: MEMORY, authorsNote: NOTE, opening: OPENING });
    expect(prompt).toContain(NOTE);
    expect(prompt.indexOf(NOTE)).toBeLessThan(prompt.indexOf(OPENING));
  });

  it('drops the HEAD of an oversized story and reports the loss', () => {
    const story = `DEBUT_A_PERDRE\n${'x'.repeat(500)}\nFIN_A_GARDER`;
    const { prompt, cut, warnings } = buildStoryPrompt({ story, windowChars: 100, memory: MEMORY });
    expect(prompt).toContain('FIN_A_GARDER');
    expect(prompt).not.toContain('DEBUT_A_PERDRE');
    expect(cut).toBeGreaterThan(0);
    expect(warnings.join(' ')).toMatch(/tronque/i);
    // Memory survives truncation — that is the point of keeping it separate.
    expect(prompt).toContain(MEMORY);
  });

  it('is pure: the same input yields byte-identical output', () => {
    const input = { attg: 'Genre: X', memory: MEMORY, story: STORY, authorsNote: NOTE, opening: OPENING };
    expect(buildStoryPrompt(input).prompt).toBe(buildStoryPrompt(input).prompt);
  });

  it('never throws on absent or malformed input', () => {
    expect(() => buildStoryPrompt()).not.toThrow();
    expect(() => buildStoryPrompt({})).not.toThrow();
    expect(() => buildStoryPrompt({ story: null, memory: 42, authorsNote: [] })).not.toThrow();
  });
});

describe('buildStoryPrompt — warnings fire on their own trigger only', () => {
  /** The complete, well-formed call: it must produce NO warning at all. */
  const clean = {
    attg: 'Genre: fantasy',
    memory: MEMORY,
    story: STORY,
    authorsNote: NOTE,
    opening: OPENING,
  };

  it('stays silent when the context is well built', () => {
    expect(buildStoryPrompt(clean).warnings).toEqual([]);
  });

  it('warns when no author\'s note steers the paragraph', () => {
    const { warnings } = buildStoryPrompt({ ...clean, authorsNote: '' });
    expect(warnings.join(' ')).toMatch(/authors_note/);
  });

  it('warns when the note is long enough to compete with the prose', () => {
    const { warnings } = buildStoryPrompt({ ...clean, authorsNote: 'z'.repeat(500) });
    expect(warnings.join(' ')).toMatch(/caracteres/);
  });

  it('warns when nothing permanent was supplied as memory', () => {
    const { warnings } = buildStoryPrompt({ ...clean, memory: '' });
    expect(warnings.join(' ')).toMatch(/memory/);
  });

  it('warns when the context ends on a closed sentence with no opening', () => {
    const { warnings } = buildStoryPrompt({ ...clean, opening: '' });
    expect(warnings.join(' ')).toMatch(/phrase complete/);
  });

  it('does NOT warn about a closed sentence when an opening is supplied', () => {
    const { warnings } = buildStoryPrompt({ ...clean, story: 'Il partit.' });
    expect(warnings.join(' ')).not.toMatch(/phrase complete/);
  });
});
