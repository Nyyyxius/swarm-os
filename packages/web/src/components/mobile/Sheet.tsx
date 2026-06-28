// packages/web/src/components/mobile/Sheet.tsx
//
// Bottom-sheet primitive ported from prototypes/mobile/mobile-sheets.jsx.
// Swipe-down-to-dismiss is initiated ONLY from the grab handle / header so
// scrolling the sheet body is never hijacked. The element stays mounted
// while closed (translateY(100%)) so it can slide in/out.
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

const DISMISS_PX = 90;

export default function Sheet({ open, onClose, children }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef<number | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (!target.closest('.m-sheet-handle') && !target.closest('.m-sheet-head')) return;
    startY.current = e.clientY;
    setDragging(true);
    sheetRef.current?.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (startY.current == null) return;
    setDrag(Math.max(0, e.clientY - startY.current));
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (startY.current == null) return;
    const dy = e.clientY - startY.current;
    startY.current = null;
    setDragging(false);
    if (dy > DISMISS_PX) onClose();
    setDrag(0);
  }

  return (
    <>
      <div
        className={`m-scrim ${open ? 'show' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={sheetRef}
        className={`m-sheet ${open ? 'open' : ''}`}
        style={{
          transform: open ? `translateY(${drag}px)` : 'translateY(100%)',
          transition: dragging ? 'none' : undefined,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="dialog"
        aria-modal="true"
      >
        <div className="m-sheet-handle" />
        {children}
      </div>
    </>
  );
}
