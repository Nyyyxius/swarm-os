import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SkillImportModal } from './SkillImportModal';
import type { MarketSearchResult, SkillInstallResult } from '../../api/client';

const baseSkill = {
  name: 'test-skill',
  version: '1.0.0',
  displayName: null,
  description: null,
  sourceKind: 'market' as const,
  sourceRef: 'pdf',
  trust: 'community' as const,
  requires: { plugins: [], capabilities: [] },
  assetsPresent: false,
  triggers: [],
  checksum: null,
  installedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastError: null,
};

const installResult: SkillInstallResult = { skill: baseSkill };

function makeProps(overrides?: Partial<Parameters<typeof SkillImportModal>[0]>) {
  return {
    install: vi.fn().mockResolvedValue(installResult),
    upload: vi.fn().mockResolvedValue(installResult),
    marketSearch: vi.fn().mockResolvedValue({ available: false, results: [] } satisfies MarketSearchResult),
    onClose: vi.fn(),
    onImported: vi.fn(),
    ...overrides,
  };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response('{}', { status: 200 }),
  ) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('SkillImportModal — render', () => {
  it('renders the dialog', () => {
    render(<SkillImportModal {...makeProps()} />);
    expect(screen.getByRole('dialog', { name: 'Import skill' })).toBeTruthy();
  });

  it('shows all four source tabs', () => {
    render(<SkillImportModal {...makeProps()} />);
    expect(screen.getByText('FOLDER')).toBeTruthy();
    expect(screen.getByText('UPLOAD .TGZ')).toBeTruthy();
    expect(screen.getByText('MARKETPLACE')).toBeTruthy();
    expect(screen.getByText('GIT')).toBeTruthy();
  });

  it('calls onClose when CANCEL is clicked', () => {
    const props = makeProps();
    render(<SkillImportModal {...props} />);
    fireEvent.click(screen.getByText('CANCEL'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SkillImportModal — dir tab', () => {
  it('IMPORT button is disabled when dir is empty', () => {
    render(<SkillImportModal {...makeProps()} />);
    const btn = screen.getByRole('button', { name: 'IMPORT' });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('calls install with source=dir when submitted', async () => {
    const props = makeProps();
    render(<SkillImportModal {...props} />);
    fireEvent.change(screen.getByPlaceholderText('/data/skills/my-skill'), {
      target: { value: '/data/skills/test' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'IMPORT' }));
    });
    expect(props.install).toHaveBeenCalledWith({ source: 'dir', dir: '/data/skills/test' });
    expect(props.onImported).toHaveBeenCalledWith(installResult);
  });
});

describe('SkillImportModal — market tab', () => {
  function switchToMarket() {
    act(() => { fireEvent.click(screen.getByText('MARKETPLACE')); });
  }

  it('shows market ref input on market tab', () => {
    render(<SkillImportModal {...makeProps()} />);
    switchToMarket();
    expect(screen.getByLabelText('marketplace ref')).toBeTruthy();
  });

  it('IMPORT is disabled when market ref is empty', () => {
    render(<SkillImportModal {...makeProps()} />);
    switchToMarket();
    expect(screen.getByRole('button', { name: 'IMPORT' })).toHaveProperty('disabled', true);
  });

  it('calls install with source=market when submitted', async () => {
    const props = makeProps();
    render(<SkillImportModal {...props} />);
    switchToMarket();
    fireEvent.change(screen.getByLabelText('marketplace ref'), {
      target: { value: 'pdf' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'IMPORT' }));
    });
    expect(props.install).toHaveBeenCalledWith({ source: 'market', ref: 'pdf' });
    expect(props.onImported).toHaveBeenCalledWith(installResult);
  });

  it('shows search input when marketSearch is provided', () => {
    render(<SkillImportModal {...makeProps()} />);
    switchToMarket();
    expect(screen.getByLabelText('marketplace search')).toBeTruthy();
  });

  it('shows "not configured" note when available=false', async () => {
    const props = makeProps({
      marketSearch: vi.fn().mockResolvedValue({
        available: false,
        results: [],
      } satisfies MarketSearchResult),
    });
    render(<SkillImportModal {...props} />);
    switchToMarket();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('marketplace search'), {
        target: { value: 'pd' },
      });
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(screen.queryByText(/not configured/)).toBeTruthy();
  });

  it('shows results and USE button when available=true', async () => {
    const props = makeProps({
      marketSearch: vi.fn().mockResolvedValue({
        available: true,
        results: [{ name: 'pdf', description: 'PDF reader skill', ref: 'pdf' }],
      } satisfies MarketSearchResult),
    });
    render(<SkillImportModal {...props} />);
    switchToMarket();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('marketplace search'), {
        target: { value: 'pdf' },
      });
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(screen.queryByText('PDF reader skill')).toBeTruthy();
    expect(screen.queryByText('USE')).toBeTruthy();
  });

  it('shows a link with correct href and target when entry has url', async () => {
    const props = makeProps({
      marketSearch: vi.fn().mockResolvedValue({
        available: true,
        results: [{ name: 'pdf', ref: 'pdf', url: 'https://github.com/anthropics/skills/tree/main/pdf' }],
      } satisfies MarketSearchResult),
    });
    render(<SkillImportModal {...props} />);
    switchToMarket();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('marketplace search'), {
        target: { value: 'pdf' },
      });
      await new Promise((r) => setTimeout(r, 500));
    });
    const link = screen.getByRole('link', { name: /Voir pdf sur GitHub/ }) as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/anthropics/skills/tree/main/pdf');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
  });

  it('shows no link when entry has no url', async () => {
    const props = makeProps({
      marketSearch: vi.fn().mockResolvedValue({
        available: true,
        results: [{ name: 'pdf', ref: 'pdf' }],
      } satisfies MarketSearchResult),
    });
    render(<SkillImportModal {...props} />);
    switchToMarket();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('marketplace search'), {
        target: { value: 'pdf' },
      });
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('clicking USE populates the ref field', async () => {
    const props = makeProps({
      marketSearch: vi.fn().mockResolvedValue({
        available: true,
        results: [{ name: 'pdf', ref: 'anthropics/skills/skills/pdf' }],
      } satisfies MarketSearchResult),
    });
    render(<SkillImportModal {...props} />);
    switchToMarket();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('marketplace search'), {
        target: { value: 'pdf' },
      });
      await new Promise((r) => setTimeout(r, 500));
    });
    fireEvent.click(screen.getByText('USE'));
    const refInput = screen.getByLabelText('marketplace ref') as HTMLInputElement;
    expect(refInput.value).toBe('anthropics/skills/skills/pdf');
  });
});

describe('SkillImportModal — git tab', () => {
  function switchToGit() {
    act(() => { fireEvent.click(screen.getByText('GIT')); });
  }

  it('shows git URL field on git tab', () => {
    render(<SkillImportModal {...makeProps()} />);
    switchToGit();
    expect(screen.getByPlaceholderText('https://github.com/owner/repo.git')).toBeTruthy();
  });

  it('calls install with source=git when submitted', async () => {
    const props = makeProps();
    render(<SkillImportModal {...props} />);
    switchToGit();
    fireEvent.change(screen.getByPlaceholderText('https://github.com/owner/repo.git'), {
      target: { value: 'https://github.com/org/repo.git' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'IMPORT' }));
    });
    expect(props.install).toHaveBeenCalledWith({
      source: 'git',
      url: 'https://github.com/org/repo.git',
    });
  });
});
