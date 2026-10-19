import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const KEY = "aw-sidebar-width";
const COLLAPSED_KEY = "aw-sidebar-collapsed";
export const SIDEBAR_DEFAULT = 304;
export const SIDEBAR_MIN = 220;
/** Dragging narrower than this hides the sidebar instead of squeezing it. */
const COLLAPSE_AT = 160;
const STEP = 16;

/** The widest the sidebar may be: half the window, so the chat stays usable. */
function maxWidth(): number {
  return Math.max(SIDEBAR_MIN, Math.min(560, Math.round(innerWidth * 0.5)));
}

export function clampWidth(value: number, max = maxWidth()): number {
  return Math.round(Math.min(Math.max(value, SIDEBAR_MIN), max));
}

function stored(): number {
  const value = Number(localStorage.getItem(KEY));
  return Number.isFinite(value) && value > 0 ? clampWidth(value) : SIDEBAR_DEFAULT;
}

/** Resizable, collapsible sidebar width persisted per browser. */
export function useSidebarWidth() {
  const [width, setWidthState] = useState(stored);
  const [collapsed, setCollapsedState] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; pointer: number } | null>(null);

  const setWidth = useCallback((value: number) => {
    const next = clampWidth(value);
    setWidthState(next);
    localStorage.setItem(KEY, String(next));
  }, []);
  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
    if (value) localStorage.setItem(COLLAPSED_KEY, "1");
    else localStorage.removeItem(COLLAPSED_KEY);
  }, []);

  // Keep a remembered width valid when the window shrinks.
  useEffect(() => {
    const onResize = () => setWidthState((current) => clampWidth(current));
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, pointer: event.pointerId };
    setDragging(true);
  }, [width]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    const proposed = state.startWidth + event.clientX - state.startX;
    if (proposed < COLLAPSE_AT) {
      setCollapsed(true);
      return;
    }
    setCollapsed(false);
    setWidthState(clampWidth(proposed));
  }, [setCollapsed]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setWidthState((current) => {
      localStorage.setItem(KEY, String(current));
      return current;
    });
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? STEP * 4 : STEP;
    if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(width - step); }
    else if (event.key === "ArrowRight") { event.preventDefault(); setCollapsed(false); setWidth(width + step); }
    else if (event.key === "Home") { event.preventDefault(); setWidth(SIDEBAR_MIN); }
    else if (event.key === "End") { event.preventDefault(); setWidth(maxWidth()); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCollapsed(!collapsed); }
  }, [width, collapsed, setWidth, setCollapsed]);

  const reset = useCallback(() => { setCollapsed(false); setWidth(SIDEBAR_DEFAULT); }, [setWidth, setCollapsed]);

  // Avoid selecting text and keep the resize cursor while dragging anywhere on the page.
  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; };
  }, [dragging]);

  return {
    width, collapsed, dragging, setCollapsed, reset, max: maxWidth(),
    handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown, onDoubleClick: reset },
  };
}
