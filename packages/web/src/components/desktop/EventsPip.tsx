// packages/web/src/components/desktop/EventsPip.tsx

interface Props {
  connected: boolean;
  /**
   * When the right detail panel is open, shift left of it. The pip is
   * `position: fixed; right: 16px` (z 49) and the panel is z 20, so without
   * this it floats over the panel's composer / SEND button (bottom-right).
   * Panel width is 400px → clear it by sitting 16px to its left.
   */
  panelOpen?: boolean;
}

export default function EventsPip({ connected, panelOpen }: Props) {
  return (
    <div
      className="events-pip"
      style={{
        right: panelOpen ? 416 : undefined,
        transition: 'right 280ms cubic-bezier(.2,.7,.2,1)',
      }}
    >
      <span className={`dot ${connected ? 'ok' : 'warn'}`} />
      events :: {connected ? 'live' : 'reconnecting…'}
    </div>
  );
}
