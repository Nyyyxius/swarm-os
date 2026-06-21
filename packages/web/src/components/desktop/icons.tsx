// packages/web/src/components/desktop/icons.tsx
// Lib d'icônes SVG inline (currentColor). Cf. v2/icons.jsx.

import type { ReactElement } from 'react';

export const ICON: Record<string, ReactElement> = {
  send:     <svg viewBox="0 0 24 24"><path d="M3 12 L21 4 L17 21 L11 13 Z"/><path d="M11 13 L3 12"/></svg>,
  stop:     <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg>,
  start:    <svg viewBox="0 0 24 24"><path d="M6 4 L20 12 L6 20 Z"/></svg>,
  pause:    <svg viewBox="0 0 24 24"><rect x="7" y="5" width="3" height="14"/><rect x="14" y="5" width="3" height="14"/></svg>,
  kill:     <svg viewBox="0 0 24 24"><path d="M5 5 L19 19"/><path d="M19 5 L5 19"/></svg>,
  reload:   <svg viewBox="0 0 24 24"><path d="M3 12 a9 9 0 0 1 15-6.7 L21 8"/><path d="M21 3 V8 H16"/><path d="M21 12 a9 9 0 0 1 -15 6.7 L3 16"/><path d="M3 21 V16 H8"/></svg>,
  fork:     <svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7 V12 a3 3 0 0 0 3 3 H15 a3 3 0 0 0 3-3 V7"/><path d="M12 15 V17"/></svg>,
  plus:     <svg viewBox="0 0 24 24"><path d="M12 5 V19"/><path d="M5 12 H19"/></svg>,
  cog:      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.5 4.5 L6.5 6.5 M17.5 17.5 L19.5 19.5 M4.5 19.5 L6.5 17.5 M17.5 6.5 L19.5 4.5"/></svg>,
  template: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5"/><rect x="3" y="11" width="18" height="5"/><rect x="3" y="18" width="18" height="3"/></svg>,
  pencil:   <svg viewBox="0 0 24 24"><path d="M4 20 L8 19 L20 7 L17 4 L5 16 Z"/><path d="M14 7 L17 10"/></svg>,
  trash:    <svg viewBox="0 0 24 24"><path d="M5 7 H19"/><path d="M9 7 V4 H15 V7"/><path d="M7 7 L8 20 H16 L17 7"/></svg>,
  inbox:    <svg viewBox="0 0 24 24"><path d="M3 13 L7 5 H17 L21 13 V20 H3 Z"/><path d="M3 13 H8 L10 16 H14 L16 13 H21"/></svg>,
  bcast:    <svg viewBox="0 0 24 24"><path d="M12 4 V20"/><path d="M5 9 a7 7 0 0 0 0 6"/><path d="M3 7 a10 10 0 0 0 0 10"/><path d="M19 9 a7 7 0 0 1 0 6"/><path d="M21 7 a10 10 0 0 1 0 10"/></svg>,
  back:     <svg viewBox="0 0 24 24"><path d="M14 6 L8 12 L14 18"/></svg>,
  copy:     <svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12"/><path d="M16 8 V4 H4 V16 H8"/></svg>,
  link:     <svg viewBox="0 0 24 24"><path d="M10 14 a4 4 0 0 0 5.66 0 L19 11 a4 4 0 0 0 -5.66 -5.66 L12 7"/><path d="M14 10 a4 4 0 0 0 -5.66 0 L5 13 a4 4 0 0 0 5.66 5.66 L12 17"/></svg>,
  expand:   <svg viewBox="0 0 24 24"><path d="M4 9 V4 H9"/><path d="M20 9 V4 H15"/><path d="M4 15 V20 H9"/><path d="M20 15 V20 H15"/></svg>,
  collapse: <svg viewBox="0 0 24 24"><path d="M9 4 V9 H4"/><path d="M15 4 V9 H20"/><path d="M9 20 V15 H4"/><path d="M15 20 V15 H20"/></svg>,
  code:     <svg viewBox="0 0 24 24"><path d="M9 7 L4 12 L9 17"/><path d="M15 7 L20 12 L15 17"/></svg>,
};

export type IconName = keyof typeof ICON;
