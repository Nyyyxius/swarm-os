import { describe, it, expect } from 'vitest';
import { NoOpNotifier } from './null.js';

describe('NoOpNotifier', () => {
  it('resolves silently for any input kind', async () => {
    const n = new NoOpNotifier();
    await expect(
      n.notify({
        kind: 'session.waiting',
        orchestrator: { id: 'o', name: 'n', role: 'r', status: 'running' },
        message: 'meh',
      }),
    ).resolves.toBeUndefined();
    await expect(
      n.notify({
        kind: 'orchestrator.ended',
        orchestrator: { id: 'o', name: 'n', role: 'r', status: 'stopped' },
        message: 'done',
      }),
    ).resolves.toBeUndefined();
  });
});
