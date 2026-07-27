import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

/**
 * Example plugins — third Vitest project.
 *
 * `examples/` is outside both packages, so until now nothing in it was run by
 * any project: `vitest.config.ts` only enumerated `packages/server` and
 * `packages/web`. A plugin ships as a verbatim directory copy (`cp -r` into
 * `/data/plugins`, or a npm-pack `.tgz`), not as a compiled bundle, so its
 * tests live in a sibling `test/` folder instead of being colocated with the
 * source the way `packages/**` does it — one line in `files`/`.npmignore`
 * excludes the whole folder from what gets installed.
 *
 * The `include` glob below is the point: it encodes that layout as config, so
 * the next example plugin inherits the convention rather than inventing one.
 * (Spelling the glob out here would close this comment block early — it
 * contains a star followed by a slash.)
 *
 * - Node environment: plugins run inside the server process, never in a DOM.
 * - Globals OFF, exactly like the server project — otherwise importing
 *   `describe`/`it`/`expect` would be mandatory in `packages/**` and optional
 *   here, which is the kind of inconsistency nobody remembers.
 * - No setup file: plugin code has zero runtime dependencies by design, so
 *   there is nothing to bootstrap.
 */
export default defineConfig({
  test: {
    name: 'examples',
    root: path.dirname(new URL(import.meta.url).pathname),
    environment: 'node',
    globals: false,
    include: ['plugins/*/test/*.test.js'],
  },
});
