import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkillReviewDialog } from './SkillReviewDialog';
import type { SkillReviewInfo } from '../../api/client';

vi.mock('../../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/client')>();
  return {
    ...mod,
    api: {
      ...mod.api,
      getSkillReview: vi.fn().mockResolvedValue({
        review: {
          name: 'test-skill',
          version: '1.0.0',
          trust: 'community',
          checksum: 'abc123',
          reviewed: false,
          reviewRequired: true,
          requires: { plugins: [], capabilities: [] },
          pluginStatus: [],
          warnings: [],
          assets: [],
        } satisfies SkillReviewInfo,
      }),
      postSkillReview: vi.fn().mockResolvedValue({ name: 'test-skill', reviewed: true }),
      activateSkill: vi.fn().mockResolvedValue({ name: 'test-skill', scope: 'orch', found: true, persisted: true, injected: true }),
    },
  };
});

const baseReview: SkillReviewInfo = {
  name: 'test-skill',
  version: '1.0.0',
  trust: 'community',
  checksum: 'abc123456789',
  reviewed: false,
  reviewRequired: true,
  requires: { plugins: [], capabilities: [] },
  pluginStatus: [],
  warnings: [],
  assets: [],
};

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as typeof fetch;
  window.localStorage.setItem('swarm-os.token', 'test-token');
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('SkillReviewDialog — render gating', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <SkillReviewDialog
        skillName="test-skill"
        review={baseReview}
        open={false}
        onClose={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders dialog when open=true', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={baseReview}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/SKILL REVIEW/)).toBeTruthy();
  });
});

describe('SkillReviewDialog — trust and status display', () => {
  it('shows trust badge', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={baseReview}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('COMMUNITY')).toBeTruthy();
  });

  it('shows NOT YET REVIEWED badge when reviewed=false', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={{ ...baseReview, reviewed: false }}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('NOT YET REVIEWED')).toBeTruthy();
  });

  it('shows PREVIOUSLY REVIEWED badge when reviewed=true', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={{ ...baseReview, reviewed: true }}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('PREVIOUSLY REVIEWED')).toBeTruthy();
  });

  it('shows checksum abbreviation', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={baseReview}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/sha:abc123456789/)).toBeTruthy();
  });
});

describe('SkillReviewDialog — warnings and plugin status', () => {
  it('shows warnings when present', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={{ ...baseReview, warnings: ['plugin foo missing', 'review required'] }}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('plugin foo missing')).toBeTruthy();
    expect(screen.getByText('review required')).toBeTruthy();
  });

  it('shows plugin status (installed+enabled=OK)', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={{
          ...baseReview,
          requires: { plugins: ['my-plugin'], capabilities: [] },
          pluginStatus: [{ name: 'my-plugin', installed: true, enabled: true }],
        }}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('OK')).toBeTruthy();
    expect(screen.getByText('my-plugin')).toBeTruthy();
  });

  it('shows plugin status MISSING when not installed', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={{
          ...baseReview,
          requires: { plugins: ['missing-plugin'], capabilities: [] },
          pluginStatus: [{ name: 'missing-plugin', installed: false, enabled: false }],
        }}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('MISSING')).toBeTruthy();
  });
});

describe('SkillReviewDialog — assets', () => {
  it('shows "No executable assets" when assets is empty', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={{ ...baseReview, assets: [] }}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/No executable assets/)).toBeTruthy();
  });

  it('shows asset list when assets present', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={{
          ...baseReview,
          assets: [{ path: 'assets/run.sh', size: 512, executable: true, isText: true }],
        }}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('assets/run.sh')).toBeTruthy();
    expect(screen.getByText('EXEC')).toBeTruthy();
  });
});

describe('SkillReviewDialog — actions', () => {
  it('shows APPROVE button when no pendingActivation', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={baseReview}
        open
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('APPROVE')).toBeTruthy();
  });

  it('shows APPROVE & ACTIVATE button when pendingActivation provided', () => {
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={baseReview}
        open
        onClose={() => undefined}
        pendingActivation={{
          body: { orchestratorId: 'orch-1', scope: 'orch' },
          onSuccess: () => undefined,
        }}
      />,
    );
    expect(screen.getByText('APPROVE & ACTIVATE')).toBeTruthy();
  });

  it('calls onClose when CANCEL is clicked', () => {
    const onClose = vi.fn();
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={baseReview}
        open
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('CANCEL'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SkillReviewDialog — fetches review when review=null', () => {
  it('calls getSkillReview when no review prop provided', async () => {
    const { api } = await import('../../api/client');
    render(
      <SkillReviewDialog
        skillName="test-skill"
        review={null}
        open
        onClose={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(api.getSkillReview).toHaveBeenCalledWith('test-skill');
    });
  });
});
