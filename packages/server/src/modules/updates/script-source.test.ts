/**
 * The one thing that keeps `script-source.ts` honest.
 *
 * The updater ships embedded in the server bundle (see that file's header for
 * why), which means `scripts/host-update.sh` and its embedded copy are two
 * representations of one artifact. This test is what forbids them from
 * diverging — and, with `UPDATE_HOST_SCRIPT_SNAPSHOT=1`, it is also how you
 * regenerate the copy after editing the script.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { HOST_UPDATE_SCRIPT_GZ_B64 } from './script-source.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../../../../scripts/host-update.sh');
const SOURCE_MODULE = path.join(HERE, 'script-source.ts');

function regenerate(script: Buffer): void {
  const b64 = zlib.gzipSync(script, { level: 9 }).toString('base64');
  const current = fs.readFileSync(SOURCE_MODULE, 'utf8');
  const next = current.replace(
    /export const HOST_UPDATE_SCRIPT_GZ_B64 =\n {2}'[A-Za-z0-9+/=]*';/,
    `export const HOST_UPDATE_SCRIPT_GZ_B64 =\n  '${b64}';`,
  );
  if (next === current) throw new Error('could not locate the generated constant to rewrite');
  fs.writeFileSync(SOURCE_MODULE, next);
}

describe('script-source.ts', () => {
  it('holds exactly the bytes of scripts/host-update.sh', () => {
    const script = fs.readFileSync(SCRIPT);
    const embedded = zlib.gunzipSync(Buffer.from(HOST_UPDATE_SCRIPT_GZ_B64, 'base64'));
    if (!embedded.equals(script) && process.env.UPDATE_HOST_SCRIPT_SNAPSHOT === '1') {
      regenerate(script);
      throw new Error('script-source.ts regenerated — re-run the tests');
    }
    expect(
      embedded.equals(script),
      'scripts/host-update.sh changed without regenerating its embedded copy. Run:\n' +
        '  UPDATE_HOST_SCRIPT_SNAPSHOT=1 npx vitest run --project server script-source',
    ).toBe(true);
  });
});
