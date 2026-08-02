import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkillsPage } from './SkillsPage';

// SkillsPage reads from SwarmController indirectly (via useShellMode only).
vi.mock('../hooks/useShellMode', () => ({
  useShellMode: () => ({ isMobile: false }),
}));

// Stub the api to avoid real fetch calls.
vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    api: {
      ...mod.api,
      listSkills: vi.fn().mockResolvedValue({ skills: [] }),
      getSkill: vi.fn().mockResolvedValue({ skill: {}, body: '# skill body' }),
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
    // The loading state resolves to empty via the mock
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
