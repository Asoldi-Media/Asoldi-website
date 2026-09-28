import React, { useEffect, useRef, useState } from 'react';
import { GripVertical, Minus, ScrollText } from 'lucide-react';
import { getSalesScriptById, SALES_SCRIPTS, salesScriptCount } from '../../../lib/sales-scripts.js';

const STORAGE_KEY = 'asoldi-sales-scripts-dock';
const MIN_W = 280;
const MIN_H = 220;
const DEFAULT_W = 400;
const DEFAULT_H = 420;
const PAD = 8;

type DockLayout = { x: number; y: number; w: number; h: number };
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

function clampLayout(next: DockLayout): DockLayout {
  const maxW = Math.max(MIN_W, window.innerWidth - PAD * 2);
  const maxH = Math.max(MIN_H, window.innerHeight - PAD * 2);
  const w = Math.min(Math.max(next.w, MIN_W), maxW);
  const h = Math.min(Math.max(next.h, MIN_H), maxH);
  const x = Math.min(Math.max(next.x, PAD), Math.max(PAD, window.innerWidth - w - PAD));
  const y = Math.min(Math.max(next.y, PAD), Math.max(PAD, window.innerHeight - h - PAD));
  return { x, y, w, h };
}

function defaultLayout(): DockLayout {
  const w = Math.min(DEFAULT_W, Math.max(MIN_W, window.innerWidth - PAD * 2));
  const h = Math.min(DEFAULT_H, Math.max(MIN_H, window.innerHeight - PAD * 2));
  return clampLayout({
    x: PAD,
    y: Math.max(PAD, window.innerHeight - h - PAD),
    w,
    h,
  });
}

function readStoredLayout(): DockLayout | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<DockLayout> : null;
    if (!parsed || typeof parsed !== 'object') return null;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    const w = Number(parsed.w);
    const h = Number(parsed.h);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    return clampLayout({ x, y, w, h });
  } catch {
    return null;
  }
}

function writeStoredLayout(layout: DockLayout) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* ignore quota */
  }
}

function resizeCursor(edge: ResizeEdge) {
  if (edge === 'e' || edge === 'w') return 'ew-resize';
  if (edge === 'n' || edge === 's') return 'ns-resize';
  if (edge === 'ne' || edge === 'sw') return 'nesw-resize';
  return 'nwse-resize';
}

export function SalesScriptsDock() {
  const count = salesScriptCount();
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<DockLayout>(() => (
    typeof window === 'undefined' ? { x: 8, y: 8, w: DEFAULT_W, h: DEFAULT_H } : (readStoredLayout() || defaultLayout())
  ));
  const [scriptId, setScriptId] = useState(SALES_SCRIPTS[0]?.id || 'ny-mote-tid');
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: DockLayout } | null>(null);
  const resizeRef = useRef<{ pointerId: number; edge: ResizeEdge; startX: number; startY: number; origin: DockLayout } | null>(null);

  useEffect(() => {
    function onResize() {
      setLayout((prev) => clampLayout(prev));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function persist(next: DockLayout) {
    const clamped = clampLayout(next);
    setLayout(clamped);
    writeStoredLayout(clamped);
  }

  function openPanel() {
    setLayout((prev) => {
      const next = clampLayout(prev.w ? prev : (readStoredLayout() || defaultLayout()));
      writeStoredLayout(next);
      return next;
    });
    setOpen(true);
  }

  function onDragPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: layout,
    };
  }

  function onDragPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    persist({
      ...drag.origin,
      x: drag.origin.x + (event.clientX - drag.startX),
      y: drag.origin.y + (event.clientY - drag.startY),
    });
  }

  function onDragPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  function onResizePointerDown(edge: ResizeEdge, event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      origin: layout,
    };
  }

  function onResizePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const dx = event.clientX - resize.startX;
    const dy = event.clientY - resize.startY;
    let { x, y, w, h } = resize.origin;
    const edge = resize.edge;
    if (edge.includes('e')) w += dx;
    if (edge.includes('s')) h += dy;
    if (edge.includes('w')) {
      x += dx;
      w -= dx;
    }
    if (edge.includes('n')) {
      y += dy;
      h -= dy;
    }
    persist({ x, y, w, h });
  }

  function onResizePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
  }

  const script = getSalesScriptById(scriptId);
  const edges: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPanel}
        className="fixed left-3 bottom-3 z-[65] inline-flex items-center gap-2 rounded-full border border-white/15 bg-[#2a2a2a] px-3 py-2 shadow-lg text-white hover:bg-[#333]"
        title="Scripts"
      >
        <ScrollText size={16} className="text-[#FF5B00] shrink-0" />
        <span className="text-sm font-medium">Scripts</span>
        <span className="min-w-5 h-5 px-1.5 rounded-full bg-[#FF5B00] text-white text-[11px] font-semibold inline-flex items-center justify-center tabular-nums">
          {count}
        </span>
      </button>
    );
  }

  return (
    <div
      className="fixed z-[65] flex flex-col rounded-2xl border border-white/15 bg-[#2a2a2a] shadow-2xl overflow-hidden"
      style={{ left: layout.x, top: layout.y, width: layout.w, height: layout.h }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-white/10 cursor-grab active:cursor-grabbing select-none touch-none"
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
        onPointerCancel={onDragPointerUp}
        title="Dra for å flytte"
      >
        <GripVertical size={16} className="text-[#FF5B00] shrink-0" />
        <ScrollText size={15} className="text-[#FF5B00] shrink-0" />
        <span className="text-sm font-semibold text-white truncate">Scripts</span>
        <span className="min-w-5 h-5 px-1.5 rounded-full bg-[#FF5B00] text-white text-[11px] font-semibold inline-flex items-center justify-center tabular-nums">
          {count}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          onPointerDown={(event) => event.stopPropagation()}
          className="ml-auto p-1 rounded-md text-gray-300 hover:bg-white/10 hover:text-white"
          title="Minimer"
        >
          <Minus size={16} />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-white/10">
        <select
          value={scriptId}
          onChange={(event) => setScriptId(event.target.value)}
          className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-2.5 py-1.5"
          aria-label="Velg script"
        >
          {SALES_SCRIPTS.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3">
        <p className="text-sm text-gray-100 leading-relaxed whitespace-pre-wrap">
          {script?.body || ''}
        </p>
      </div>

      {edges.map((edge) => {
        const isCorner = edge.length === 2;
        const style: React.CSSProperties = { cursor: resizeCursor(edge) };
        if (edge.includes('n')) {
          style.top = 0;
          style.height = isCorner ? 14 : 8;
        }
        if (edge.includes('s')) {
          style.bottom = 0;
          style.height = isCorner ? 18 : 8;
        }
        if (edge.includes('w')) {
          style.left = 0;
          style.width = isCorner ? 14 : 8;
        }
        if (edge.includes('e')) {
          style.right = 0;
          style.width = isCorner ? 18 : 8;
        }
        if (edge === 'n' || edge === 's') {
          style.left = 12;
          style.right = 12;
        }
        if (edge === 'e' || edge === 'w') {
          style.top = 12;
          style.bottom = 12;
        }
        return (
          <div
            key={edge}
            role="presentation"
            className={`absolute ${edge === 'se' ? 'bg-[#FF5B00]/70 rounded-tl' : ''}`}
            style={style}
            onPointerDown={(event) => onResizePointerDown(edge, event)}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            title={edge === 'se' ? 'Dra for å endre størrelse' : undefined}
          />
        );
      })}
    </div>
  );
}
