import { useCallback, useSyncExternalStore } from "react";

const KEY = "aw-pinned";
const listeners = new Set<() => void>();
let cache: string[] | null = null;

function read(): string[] {
  if (cache) return cache;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: string[]): void {
  cache = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Other tabs pin too.
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) { cache = null; listener(); } };
  addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); removeEventListener("storage", onStorage); };
}

/** Pinned session ids, kept in this browser only; newest pin first. */
export function usePins() {
  const pins = useSyncExternalStore(subscribe, read);
  const toggle = useCallback((id: string) => {
    const current = read();
    write(current.includes(id) ? current.filter((entry) => entry !== id) : [id, ...current]);
  }, []);
  const unpin = useCallback((id: string) => {
    const current = read();
    if (current.includes(id)) write(current.filter((entry) => entry !== id));
  }, []);
  return { pins, toggle, unpin };
}
