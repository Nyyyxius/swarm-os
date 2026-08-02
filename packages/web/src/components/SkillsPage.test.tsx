import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkillsPage } from './SkillsPage';

// SkillsPage reads from SwarmController.
vi.mock('../controller/SwarmController', () => ({
  useSwarmController: () => ({
    orchestrators: [],
    roles: [],
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
      listSkills: vi.fn().mockResolvedValue({ skills: [] }),
      getSkill: vi.fn().mockResolvedValue({ skill: {}, body: '# skill body' }),
      getSkillActivations: vi.fn().mockResolvedValue({ activations: [] }),
    },
  };
});

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response('{"skills":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as typeof fetch;
  window.localStorage.setItem('swarm-os.token', 'test-token');
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('SkillsPage render gating', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <SkillsPage open={false} onClose={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the overlay when open=true', () => {
    render(<SkillsPage open onClose={() => undefined} />);
    expect(screen.getByText('SKILLS')).toBeTruthy();
  });

  it('shows back button when open=true', () => {
    render(<SkillsPage open onClose={() => undefined} />);
    expect(screen.getByText('← BACK TO MAP')).toBeTruthy();
  });

  it('calls onClose when the back button is clicked', () => {
    const onClose = vi.fn();
    render(<SkillsPage open onClose={onClose} />);
    screen.getByText('← BACK TO MAP').click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows empty-state message when no skills loaded', async () => {
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText(/No skills yet/)).toBeTruthy();
    });
  });

  it('shows import button', () => {
    render(<SkillsPage open onClose={() => undefined} />);
    expect(screen.getByText('IMPORT SKILL')).toBeTruthy();
  });
});

describe('SkillsPage activation note', () => {
  it('renders the /clear activation note when a skill is selected', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [
        {
          name: 'my-skill',
          version: '0.1.0',
          displayName: null,
          description: null,
          sourceKind: 'dir',
          sourceRef: null,
          trust: 'local',
          requires: { plugins: [], capabilities: [] },
          assetsPresent: false,
          triggers: [],
          checksum: null,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastError: null,
        },
      ],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText(/Activation note/)).toBeTruthy();
    });
  });
});

describe('SkillsPage activation panel (Lot 2b)', () => {
  it('shows ACTIVATIONS section when skill is selected', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [
        {
          name: 'my-skill',
          version: '0.1.0',
          displayName: null,
          description: null,
          sourceKind: 'dir',
          sourceRef: null,
          trust: 'local',
          requires: { plugins: [], capabilities: [] },
          assetsPresent: false,
          triggers: [],
          checksum: null,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastError: null,
        },
      ],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText('ACTIVATIONS')).toBeTruthy();
    });
  });

  it('shows "No orch/session activations" when activations list is empty', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [
        {
          name: 'my-skill',
          version: '0.1.0',
          displayName: null,
          description: null,
          sourceKind: 'dir',
          sourceRef: null,
          trust: 'local',
          requires: { plugins: [], capabilities: [] },
          assetsPresent: false,
          triggers: [],
          checksum: null,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastError: null,
        },
      ],
    });
    (api.getSkillActivations as ReturnType<typeof vi.fn>).mockResolvedValue({ activations: [] });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText(/No orch\/session activations/)).toBeTruthy();
    });
  });

  it('shows sourceCommit in metadata when present', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [
        {
          name: 'my-skill',
          version: '0.1.0',
          displayName: null,
          description: null,
          sourceKind: 'git',
          sourceRef: 'github.com/org/skill',
          trust: 'community',
          requires: { plugins: [], capabilities: [] },
          assetsPresent: false,
          triggers: [],
          checksum: null,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastError: null,
          sourceCommit: 'abc1234567890',
        },
      ],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText('commit')).toBeTruthy();
      expect(screen.queryByText('abc123456789')).toBeTruthy();
    });
  });
});

describe('SkillsPage Lot 3b — trust badges and review indicators', () => {
  function makeSkill(overrides: object = {}) {
    return {
      name: 'my-skill',
      version: '1.0.0',
      displayName: null,
      description: null,
      sourceKind: 'dir',
      sourceRef: null,
      trust: 'local',
      requires: { plugins: [], capabilities: [] },
      assetsPresent: false,
      triggers: [],
      checksum: null,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: null,
      reviewed: false,
      reviewRequired: false,
      pluginStatus: [],
      warnings: [],
      ...overrides,
    };
  }

  it('shows VÉRIFIÉ badge for first-party trust', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [makeSkill({ trust: 'first-party' })],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryAllByText('VÉRIFIÉ').length).toBeGreaterThan(0);
    });
  });

  it('shows VÉRIFIÉ badge for verified trust', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [makeSkill({ trust: 'verified' })],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryAllByText('VÉRIFIÉ').length).toBeGreaterThan(0);
    });
  });

  it('shows REVIEW REQ badge when reviewRequired=true', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [makeSkill({ reviewRequired: true, assetsPresent: true })],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText('REVIEW REQ')).toBeTruthy();
    });
  });

  it('shows warnings section when warnings are present', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [makeSkill({ warnings: ['plugin foo is missing'] })],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText('WARNINGS')).toBeTruthy();
      expect(screen.queryByText('plugin foo is missing')).toBeTruthy();
    });
  });

  it('shows REVIEW button when assetsPresent=true', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [makeSkill({ assetsPresent: true })],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText('REVIEW')).toBeTruthy();
    });
  });

  it('shows review status "required — not yet approved" when reviewRequired and not reviewed', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [makeSkill({ reviewRequired: true, reviewed: false, assetsPresent: true })],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText(/required — not yet approved/)).toBeTruthy();
    });
  });

  it('shows plugin status with OK when plugin installed and enabled', async () => {
    const { api } = await import('../api/client');
    (api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [
        makeSkill({
          requires: { plugins: ['my-plugin'], capabilities: [] },
          pluginStatus: [{ name: 'my-plugin', installed: true, enabled: true }],
        }),
      ],
    });
    render(<SkillsPage open onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.queryByText('REQUIRES')).toBeTruthy();
      expect(screen.queryByText('OK')).toBeTruthy();
      expect(screen.queryByText('my-plugin (plugin)')).toBeTruthy();
    });
  });
});
