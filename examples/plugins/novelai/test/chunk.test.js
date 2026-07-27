// Tests for `chunkForTts` from `../lib/nai.js`.
//
// NovelAI's TTS endpoint caps a single call around 1000 characters, so longer
// text has to be split into several files. The split is a pure function with
// one hard invariant and one soft goal:
//
//   HARD — no piece may exceed the limit, ever. A piece over the cap is a 400
//   from NovelAI mid-way through a multi-file generation, i.e. a partial
//   result the agent cannot use. Sentence splitting, newline fallback and the
//   hard cut all exist to serve this one guarantee, and every case below
//   re-checks it.
//
//   SOFT — cut on sentence boundaries when possible, because the pieces are
//   never re-encoded (the runtime image has no ffmpeg): each one becomes its
//   own audio file, and a cut mid-word is audible.
//
// Plus a ceiling of 12 pieces so an agent cannot queue a novel.

import { describe, it, expect } from 'vitest';

import { chunkForTts } from '../lib/nai.js';

const MAX_CHUNKS = 12;

/** The invariant, asserted on every result in this file. */
function expectWithinLimit(chunks, limit) {
  for (const chunk of chunks) {
    expect(chunk.length, `piece over the ${limit}-char limit: ${JSON.stringify(chunk.slice(0, 40))}`)
      .toBeLessThanOrEqual(limit);
    expect(chunk.trim().length).toBeGreaterThan(0);
  }
  expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
}

describe('chunkForTts', () => {
  it('returns a single piece for a short text', () => {
    const text = 'Bonjour, ceci est un test.';
    const chunks = chunkForTts(text);

    expect(chunks).toEqual([text]);
    expectWithinLimit(chunks, 900);
  });

  it('returns nothing for empty or blank input', () => {
    expect(chunkForTts('')).toEqual([]);
    expect(chunkForTts('   \n  ')).toEqual([]);
    expect(chunkForTts(null)).toEqual([]);
    expect(chunkForTts(undefined)).toEqual([]);
  });

  it('cuts on sentence boundaries rather than mid-sentence', () => {
    const text = 'Aaa bbb ccc. Ddd eee fff. Ggg hhh.';
    const chunks = chunkForTts(text, 20);

    expect(chunks).toEqual(['Aaa bbb ccc.', 'Ddd eee fff.', 'Ggg hhh.']);
    expectWithinLimit(chunks, 20);
  });

  it('packs several short sentences into one piece when they fit', () => {
    const text = 'Un. Deux. Trois.';
    const chunks = chunkForTts(text, 900);

    expect(chunks).toEqual([text]);
  });

  it('does not treat a decimal point as a sentence boundary', () => {
    const chunks = chunkForTts('La version 3.5 est sortie. Enfin.', 900);
    expect(chunks).toEqual(['La version 3.5 est sortie. Enfin.']);
  });

  it('falls back to newlines when there is no sentence terminator', () => {
    const text = 'aaaa bbbb cccc dddd\neeee ffff gggg hhhh\niiii';
    const chunks = chunkForTts(text, 20);

    expect(chunks).toEqual(['aaaa bbbb cccc dddd', 'eeee ffff gggg hhhh', 'iiii']);
    expectWithinLimit(chunks, 20);
  });

  it('hard-cuts a single sentence that is too long, losing nothing', () => {
    const text = 'a'.repeat(250);
    const chunks = chunkForTts(text, 100);

    expect(chunks).toEqual(['a'.repeat(100), 'a'.repeat(100), 'a'.repeat(50)]);
    expect(chunks.join('')).toBe(text);
    expectWithinLimit(chunks, 100);
  });

  it('keeps every piece within the limit on mixed content', () => {
    const text = [
      'Court.',
      'Une phrase de longueur moyenne qui tient largement dans la limite.',
      'x'.repeat(140),
      'Encore une phrase, avec des virgules, et une fin !',
      'y'.repeat(51),
    ].join(' ');

    const chunks = chunkForTts(text, 50);

    expect(chunks.length).toBeGreaterThan(1);
    expectWithinLimit(chunks, 50);
  });

  it('honours a custom limit and rejects a nonsensical one', () => {
    const text = 'Aaa bbb ccc. Ddd eee fff. Ggg hhh iii. Jjj kkk lll.';

    expectWithinLimit(chunkForTts(text, 15), 15);
    // A zero/negative/NaN limit falls back to the 900 default rather than
    // looping or emitting empty pieces.
    expectWithinLimit(chunkForTts(text, 0), 900);
    expectWithinLimit(chunkForTts(text, -5), 900);
    expectWithinLimit(chunkForTts(text, Number.NaN), 900);
  });

  it('caps the result at 12 pieces so an agent cannot queue a novel', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Phrase numero ${i}.`).join(' ');
    const chunks = chunkForTts(text, 20);

    expect(chunks).toHaveLength(MAX_CHUNKS);
    expectWithinLimit(chunks, 20);
    // The pieces kept are the FIRST ones, in order — the tail is dropped.
    expect(chunks[0]).toBe('Phrase numero 0.');
    expect(chunks[MAX_CHUNKS - 1]).toBe(`Phrase numero ${MAX_CHUNKS - 1}.`);
  });

  it('normalises CRLF so a Windows-authored text does not blow the limit', () => {
    const chunks = chunkForTts('aaaa bbbb cccc dddd\r\neeee ffff gggg hhhh', 20);
    expectWithinLimit(chunks, 20);
    expect(chunks.some((c) => c.includes('\r'))).toBe(false);
  });
});
