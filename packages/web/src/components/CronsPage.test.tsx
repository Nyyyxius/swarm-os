// CronsPage — the guards that matter for the `#/crons` screen.
//
// Two of these lock properties that are easy to "optimise" away later:
//
//  - PAUSE is NOT optimistic. The row must flip to PAUSED because the refreshed
//    list says so, never because the click said so — the server also recomputes
//    `nextRun` when it re-arms, and a locally-flipped row would advertise a
//    fire that no longer exists.
//  - the cron expression is validated CLIENT-SIDE, with croner, BEFORE the
//    POST. A 6-field (per-second) pattern must never leave the browser.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CronsPage, previewSchedule, validateCronName } from './CronsPage';
import type { CronView } from '../api/client';

vi.mock('../controller/SwarmController', () => ({
  useSwarmController: () => ({
    orchestrators: [],
    roles: [{ id: 'role_dev', label: 'dev', connectors: [] }],
  }),
}));

vi.mock('../hooks/useShellMode', () => ({
  useShellMode: () => ({ isMobile: false }),
}));

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    api: {
      ...mod.api,
      listCrons: vi.fn().mockResolvedValue({ crons: [], schedulingEnabled: true }),
      listCronRuns: vi.fn().mockResolvedValue({ runs: [] }),
      createCron: vi.fn(),
      updateCron: vi.fn(),
      deleteCron: vi.fn().mockResolvedValue(undefined),
      fireCron: vi.fn(),
    },
  };
});

function cronFixture(over: Partial<CronView> = {}): CronView {
  return {
    id: 'cron_a1b2c3d4',
    name: 'daily-standup',
    roleId: 'role_dev',
    schedule: '0 9 * * 1-5',
    action: 'message',
    message: 'Point d’étape {{now}}',
    scriptPath: null,
    scriptArgs: null,
    interpreter: null,
    timeoutMs: null,
    paused: false,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    nextRun: '2026-09-01T09:00:00.000Z',
    lastRun: null,
    running: false,
    ...over,
  };
}

function renderPage(props: Partial<React.ComponentProps<typeof CronsPage>> = {}) {
  const onClose = vi.fn();
  const onSelectCron = vi.fn();
  render(
    <CronsPage
      open
      cronId={null}
      onClose={onClose}
      onSelectCron={onSelectCron}
      {...props}
    />,
  );
  return { onClose, onSelectCron };
}

/**
 * Queries scoped to the sidebar list. The selected cron's name, its PAUSED
 * state and its schedule are ALSO painted in the detail pane, so an unscoped
 * `getByText` matches twice — and "the list shows PAUSED" is the assertion
 * these tests are actually about.
 */
function list() {
  const el = document.querySelector('.roles-list');
  if (!el) throw new Error('roles-list not rendered');
  return within(el as HTMLElement);
}

beforeEach(() => {
  window.localStorage.setItem('swarm-os.token', 'test-token');
});
afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('CronsPage — rendu', () => {
  it('ne rend rien tant que open=false', () => {
    const { container } = render(
      <CronsPage open={false} cronId={null} onClose={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('rend l’overlay et le titre quand open=true', () => {
    renderPage();
    expect(screen.getByText('CRONS')).toBeTruthy();
    expect(screen.getByText('← BACK TO MAP')).toBeTruthy();
  });

  it('affiche un empty state quand la liste est vide', async () => {
    renderPage();
    await vi.waitFor(() => {
      expect(screen.queryByText(/Aucun cron pour l’instant/)).toBeTruthy();
    });
  });

  it('appelle onClose au clic sur BACK TO MAP', () => {
    const { onClose } = renderPage();
    fireEvent.click(screen.getByText('← BACK TO MAP'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('liste un cron avec son expression, son action et son rôle cible', async () => {
    const { api } = await import('../api/client');
    (api.listCrons as ReturnType<typeof vi.fn>).mockResolvedValue({
      crons: [cronFixture()],
      schedulingEnabled: true,
    });
    renderPage();
    await vi.waitFor(() => {
      expect(list().getByText('DAILY-STANDUP')).toBeTruthy();
    });
    expect(list().getByText('0 9 * * 1-5')).toBeTruthy();
    expect(list().getByText('MESSAGE')).toBeTruthy();
    expect(list().getByText('→ DEV')).toBeTruthy();
  });

  it('affiche le bandeau SCHEDULING DISABLED quand la cadence est coupée', async () => {
    const { api } = await import('../api/client');
    (api.listCrons as ReturnType<typeof vi.fn>).mockResolvedValue({
      crons: [cronFixture()],
      schedulingEnabled: false,
    });
    renderPage();
    await vi.waitFor(() => {
      expect(screen.queryByText(/SCHEDULING DISABLED/)).toBeTruthy();
    });
  });
});

describe('CronsPage — pause non optimiste', () => {
  it('n’affiche PAUSED qu’une fois la liste rafraîchie par le serveur', async () => {
    const { api } = await import('../api/client');
    const listCrons = api.listCrons as ReturnType<typeof vi.fn>;
    // 1er GET : actif. Le PATCH répond « paused », mais le 2e GET aussi — c'est
    // LUI qui doit faire apparaître la pastille.
    listCrons.mockResolvedValueOnce({ crons: [cronFixture()], schedulingEnabled: true });
    listCrons.mockResolvedValue({
      crons: [cronFixture({ paused: true, nextRun: null })],
      schedulingEnabled: true,
    });
    (api.updateCron as ReturnType<typeof vi.fn>).mockResolvedValue({
      cron: cronFixture({ paused: true, nextRun: null }),
    });

    renderPage();
    await vi.waitFor(() => expect(list().getByText('DAILY-STANDUP')).toBeTruthy());
    expect(list().queryByText('PAUSED')).toBeNull();

    fireEvent.click(screen.getByText('PAUSE'));

    await vi.waitFor(() => {
      expect(list().queryByText('PAUSED')).toBeTruthy();
    });
    expect(api.updateCron).toHaveBeenCalledWith('cron_a1b2c3d4', { paused: true });
  });

  it('ne flippe PAS la pastille quand le serveur n’a pas enregistré la pause', async () => {
    const { api } = await import('../api/client');
    // Le PATCH « réussit » mais la liste rafraîchie reste active (autre onglet
    // qui a repris le cron, écriture perdue…). L'UI doit suivre le serveur.
    (api.listCrons as ReturnType<typeof vi.fn>).mockResolvedValue({
      crons: [cronFixture()],
      schedulingEnabled: true,
    });
    (api.updateCron as ReturnType<typeof vi.fn>).mockResolvedValue({
      cron: cronFixture({ paused: true }),
    });

    renderPage();
    await vi.waitFor(() => expect(list().getByText('DAILY-STANDUP')).toBeTruthy());
    fireEvent.click(screen.getByText('PAUSE'));

    await vi.waitFor(() => expect(api.updateCron).toHaveBeenCalled());
    expect(list().queryByText('PAUSED')).toBeNull();
  });
});

describe('CronsPage — validation cron côté client', () => {
  it('refuse une expression à 6 champs sans jamais appeler POST /crons', async () => {
    const { api } = await import('../api/client');
    renderPage();
    await vi.waitFor(() => expect(screen.getByText('+ NEW CRON')).toBeTruthy());
    fireEvent.click(screen.getByText('+ NEW CRON'));

    fireEvent.change(screen.getByLabelText('NAME'), { target: { value: 'per-second' } });
    fireEvent.change(screen.getByLabelText('TEMPLATE'), { target: { value: 'wake up' } });
    fireEvent.change(screen.getByLabelText('SCHEDULE'), {
      target: { value: '* * * * * *' },
    });

    expect(screen.getByText(/exactement 5 champs/)).toBeTruthy();
    fireEvent.click(screen.getByText('CREATE CRON'));
    expect(api.createCron).not.toHaveBeenCalled();
  });

  it('refuse un nom hors slug sans appeler POST /crons', async () => {
    const { api } = await import('../api/client');
    renderPage();
    await vi.waitFor(() => expect(screen.getByText('+ NEW CRON')).toBeTruthy());
    fireEvent.click(screen.getByText('+ NEW CRON'));

    fireEvent.change(screen.getByLabelText('NAME'), { target: { value: 'bad name:x' } });
    fireEvent.change(screen.getByLabelText('TEMPLATE'), { target: { value: 'wake up' } });
    fireEvent.click(screen.getByText('CREATE CRON'));

    expect(api.createCron).not.toHaveBeenCalled();
    // Scoped to the alert: the same sentence also serves as the field's help.
    expect(within(screen.getByRole('alert')).getByText(/Slug de 1 à 64/)).toBeTruthy();
  });

  it('poste le cron quand l’expression et le nom sont valides', async () => {
    const { api } = await import('../api/client');
    (api.createCron as ReturnType<typeof vi.fn>).mockResolvedValue({
      cron: cronFixture({ id: 'cron_new00001', name: 'nightly' }),
    });
    renderPage();
    await vi.waitFor(() => expect(screen.getByText('+ NEW CRON')).toBeTruthy());
    fireEvent.click(screen.getByText('+ NEW CRON'));

    fireEvent.change(screen.getByLabelText('NAME'), { target: { value: 'nightly' } });
    fireEvent.change(screen.getByLabelText('SCHEDULE'), { target: { value: '0 3 * * *' } });
    fireEvent.change(screen.getByLabelText('TEMPLATE'), { target: { value: 'rapport {{now}}' } });
    fireEvent.click(screen.getByText('CREATE CRON'));

    await vi.waitFor(() => expect(api.createCron).toHaveBeenCalledTimes(1));
    expect(api.createCron).toHaveBeenCalledWith({
      name: 'nightly',
      roleId: 'role_dev',
      schedule: '0 3 * * *',
      action: 'message',
      message: 'rapport {{now}}',
    });
  });
});

describe('previewSchedule / validateCronName', () => {
  it('accepte une expression 5 champs et rend 3 tirs à venir', () => {
    const p = previewSchedule('0 6,12,20 * * *');
    expect(p.ok).toBe(true);
    expect(p.error).toBeNull();
    expect(p.next).toHaveLength(3);
  });

  it('refuse 6 champs (pas de cron à la seconde)', () => {
    const p = previewSchedule('*/5 * * * * *');
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/5 champs/);
  });

  it('refuse une expression syntaxiquement invalide', () => {
    expect(previewSchedule('99 * * * *').ok).toBe(false);
  });

  it('refuse une expression vide', () => {
    expect(previewSchedule('   ').ok).toBe(false);
  });

  it('valide le slug de nom comme le serveur', () => {
    expect(validateCronName('daily-standup.v2')).toBeNull();
    expect(validateCronName('-leading-dash')).not.toBeNull();
    expect(validateCronName('has space')).not.toBeNull();
    expect(validateCronName('has:colon')).not.toBeNull();
    expect(validateCronName('')).not.toBeNull();
  });
});
