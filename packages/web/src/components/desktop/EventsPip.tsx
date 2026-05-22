// packages/web/src/components/desktop/EventsPip.tsx

interface Props {
  connected: boolean;
}

export default function EventsPip({ connected }: Props) {
  return (
    <div className="events-pip">
      <span className={`dot ${connected ? 'ok' : 'warn'}`} />
      events :: {connected ? 'live' : 'reconnecting…'}
    </div>
  );
}
