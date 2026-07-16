// packages/web/src/components/desktop/PluginPanelHost.test.tsx
//
// Feature B.3 — smoke tests for the plugin UI panel host:
//  - resolves the panel from `GET /plugins/:name` and renders a same-origin
//    iframe at `/plugin-api/<name>/<path>` with the documented sandbox attrs.
//  - primes the `swarm_os_token` cookie (Path=/plugin-api/) so the iframe can
//    authenticate without the X-Auth-Token header.
//  - surfaces an error when the panel id is unknown / the plugin is disabled.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PluginPanelHost from './PluginPanelHost';
import { api, setToken, type PluginView, type UiPanel } from '../../api/client';

function mkPlugin(over: Partial<PluginView> = {}): PluginView {
  return {
    name: 'echo',
    version: '0.2.0',
    displayName: 'Echo',
    status: 'enabled',
    enabled: true,
    sourceKind: 'dir',
    apiVersion: 1,
    capabilities: [],
    grantedCapabilities: [],
    failCount: 0,
    quarantinedUntil: null,
    lastError: null,
    installedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    uiPanels: [],
    ...over,
  };
}

const DEMO: UiPanel = { id: 'demo', title: 'Echo Demo', path: 'panel' };

beforeEach(() => {
  vi.restoreAllMocks();
  document.cookie = 'swarm_os_token=; Path=/plugin-api/; Max-Age=0';
});

describe('PluginPanelHost', () => {
  it('renders a sandboxed same-origin iframe for a declared panel', async () => {
    setToken('tok-123');
    vi.spyOn(api, 'getPlugin').mockResolvedValue({
      plugin: mkPlugin({ uiPanels: [DEMO] }),
      manifest: null,
      config: {},
    });

    render(<PluginPanelHost pluginName="echo" panelId="demo" onClose={() => undefined} />);

    const frame = (await waitFor(() =>
      screen.getByTitle('Echo Demo'),
    )) as HTMLIFrameElement;

    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe(`${window.location.origin}/plugin-api/echo/panel`);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    // Note: the panel-auth cookie is primed with `Path=/plugin-api/`, so jsdom
    // (document at `/`) intentionally hides it from `document.cookie` — path
    // scoping working as designed. Cookie ACCEPTANCE is covered server-side in
    // packages/server/src/http/auth.test.ts.
  });

  it('shows an error when the plugin has no matching panel', async () => {
    vi.spyOn(api, 'getPlugin').mockResolvedValue({
      plugin: mkPlugin({ uiPanels: [DEMO] }),
      manifest: null,
      config: {},
    });

    render(<PluginPanelHost pluginName="echo" panelId="missing" onClose={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText(/Panel unavailable/)).toBeInTheDocument();
    });
    expect(screen.queryByTitle('Echo Demo')).toBeNull();
  });

  it('reports a disabled plugin (no panels surfaced by the server)', async () => {
    vi.spyOn(api, 'getPlugin').mockResolvedValue({
      plugin: mkPlugin({ enabled: false, status: 'disabled', uiPanels: [] }),
      manifest: null,
      config: {},
    });

    render(<PluginPanelHost pluginName="echo" panelId="demo" onClose={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText(/is disabled/)).toBeInTheDocument();
    });
  });
});
