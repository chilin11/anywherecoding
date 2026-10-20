import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAvailability, Approval, Item, RelayEvent, SessionStatus, SessionSummary } from "../../server/types.ts";
import { api, ApiError, subscribe } from "./api.ts";

export type Thread = { items: Item[]; before: string | null; loading: boolean; error: string | null };

export type Toast = { id: number; level: "info" | "error"; message: string };

function upsert(items: Item[], item: Item): Item[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  // A completed item replaces a streamed one; keep streamed text if the final one is empty.
  next[index] = { ...item, text: item.text || items[index].text };
  return next;
}

/** Keep the history order while preserving live updates and previously loaded pages. */
function mergeHistory(history: Item[], current: Item[], baseline: Map<string, Item>, older: boolean): Item[] {
  const live = new Map(current.map((item) => [item.id, item]));
  const historyIds = new Set(history.map((item) => item.id));
  if (!older && history.length && !current.some((item) => historyIds.has(item.id))) {
    return [...current.filter((item) => baseline.has(item.id)), ...history, ...current.filter((item) => !baseline.has(item.id))];
  }
  const merged: Item[] = [];
  let cursor = 0;
  for (const item of history) {
    const index = current.findIndex((entry) => entry.id === item.id);
    if (index >= cursor) {
      for (; cursor < index; cursor++) {
        if (!historyIds.has(current[cursor].id)) merged.push(current[cursor]);
      }
      cursor = index + 1;
    }
    const existing = live.get(item.id);
    // Only an item changed during this request wins over persisted history.
    merged.push(existing && existing !== baseline.get(item.id) ? existing : item);
  }
  for (; cursor < current.length; cursor++) {
    if (!historyIds.has(current[cursor].id)) merged.push(current[cursor]);
  }
  return merged;
}

/** Browser notification while the page is in the background; clicking opens the session. */
function notify(title: string, body: string, tag: string, sessionId: string): void {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, { body, tag, icon: "/icon-192.png" });
    notification.onclick = () => {
      window.focus();
      location.hash = `#/s/${encodeURIComponent(sessionId)}`;
      notification.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}

/** All client state: sessions, open transcripts, approvals and the event stream. */
export function useRelay(authed: boolean) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<AgentAvailability[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const loadedRef = useRef(new Set<string>());
  const historyRequests = useRef(new Map<string, symbol>());
  const historyReady = useRef(new Set<string>());
  const sessionsRequest = useRef(0);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  /** Last status seen per session, to notice running → idle. */
  const lastStatus = useRef(new Map<string, SessionStatus>());

  const toast = useCallback((level: Toast["level"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, level, message }]);
    setTimeout(() => setToasts((list) => list.filter((entry) => entry.id !== id)), level === "error" ? 8000 : 4000);
  }, []);

  const refreshSessions = useCallback(async () => {
    const request = ++sessionsRequest.current;
    try {
      const result = await api.sessions();
      if (request !== sessionsRequest.current) return;
      setSessions(result.sessions);
      setErrors(result.errors);
      setAgents(result.agents);
      const enabled = new Set(result.agents.map((entry) => entry.agent));
      const retained = (id: string) => enabled.has(id.slice(0, id.indexOf(":")) as typeof result.agents[number]["agent"]);
      setApprovals((all) => all.filter((entry) => retained(entry.sessionId)));
      setStatuses((all) => Object.fromEntries(Object.entries(all).filter(([id]) => retained(id))));
      for (const id of loadedRef.current) if (!retained(id)) { loadedRef.current.delete(id); historyRequests.current.delete(id); historyReady.current.delete(id); }
      setThreads((all) => Object.fromEntries(Object.entries(all).filter(([id]) => retained(id))));
    } catch (error) {
      if (request !== sessionsRequest.current) return;
      if (!(error instanceof ApiError && error.status === 401)) toast("error", (error as Error).message);
    }
  }, [toast]);

  const loadThread = useCallback(async (id: string, older = false) => {
    const previous = threadsRef.current[id];
    const before = older ? previous?.before ?? null : null;
    if (older && (!before || previous?.loading)) return;
    const request = Symbol();
    historyRequests.current.set(id, request);
    loadedRef.current.add(id);
    const baseline = new Map(previous?.items.map((item) => [item.id, item]));
    const hadHistory = historyReady.current.has(id);
    setThreads((all) => ({ ...all, [id]: { items: all[id]?.items ?? [], before: all[id]?.before ?? null, loading: true, error: null } }));
    try {
      const page = await api.history(id, before);
      if (historyRequests.current.get(id) !== request) return;
      historyReady.current.add(id);
      setThreads((all) => {
        if (historyRequests.current.get(id) !== request) return all;
        const current = all[id];
        const items = mergeHistory(page.items, current?.items ?? [], baseline, older);
        // A refresh retains older pages and their pagination cursor.
        const overlaps = page.items.some((item) => baseline.has(item.id));
        const cursor = !older && hadHistory && (overlaps || !page.items.length) ? current?.before ?? null : page.before;
        return { ...all, [id]: { items, before: cursor, loading: false, error: null } };
      });
    } catch (error) {
      if (historyRequests.current.get(id) !== request) return;
      setThreads((all) => historyRequests.current.get(id) !== request ? all : ({ ...all, [id]: { ...(all[id] ?? { items: [], before: null }), loading: false, error: (error as Error).message } }));
    }
  }, []);

  const onEvent = useCallback((event: RelayEvent) => {
    switch (event.type) {
      case "hello":
        setApprovals(event.approvals);
        setAgents(event.agents);
        break;
      case "sessions":
        void refreshSessions();
        break;
      case "item":
        if (!loadedRef.current.has(event.sessionId)) break;
        setThreads((all) => {
          const thread = all[event.sessionId];
          if (!thread) return all;
          return { ...all, [event.sessionId]: { ...thread, items: upsert(thread.items, event.item) } };
        });
        break;
      case "delta":
        if (!loadedRef.current.has(event.sessionId)) break;
        setThreads((all) => {
          const thread = all[event.sessionId];
          if (!thread) return all;
          const existing = thread.items.find((item) => item.id === event.itemId);
          const item: Item = existing
            ? { ...existing, text: existing.text + event.text, streaming: true }
            : { id: event.itemId, kind: "assistant", text: event.text, streaming: true, ts: Date.now() };
          return { ...all, [event.sessionId]: { ...thread, items: upsert(thread.items, item) } };
        });
        break;
      case "status": {
        const previous = lastStatus.current.get(event.sessionId) ?? sessionsRef.current.find((entry) => entry.id === event.sessionId)?.status;
        lastStatus.current.set(event.sessionId, event.status);
        if (event.status === "idle" && (previous === "running" || previous === "approval")) {
          const title = sessionsRef.current.find((entry) => entry.id === event.sessionId)?.title ?? "会话";
          notify("任务已完成", title, `done:${event.sessionId}`, event.sessionId);
        }
        setStatuses((all) => ({ ...all, [event.sessionId]: event.status }));
        if (event.status === "idle") {
          // Settle any streaming flags left by deltas whose completion we missed.
          setThreads((all) => {
            const thread = all[event.sessionId];
            if (!thread?.items.some((item) => item.streaming)) return all;
            return { ...all, [event.sessionId]: { ...thread, items: thread.items.map((item) => (item.streaming ? { ...item, streaming: false } : item)) } };
          });
        }
        break;
      }
      case "approval":
        setApprovals((list) => [...list.filter((entry) => entry.id !== event.approval.id), event.approval]);
        notify(event.approval.title, event.approval.detail.slice(0, 120) || "等待审批", event.approval.id, event.approval.sessionId);
        break;
      case "approvalResolved":
        setApprovals((list) => list.filter((entry) => entry.id !== event.id));
        break;
      case "notice":
        toast(event.level, event.message);
        break;
    }
  }, [refreshSessions, toast]);

  useEffect(() => {
    if (!authed) {
      setConnected(false);
      return;
    }
    void refreshSessions();
    const unsubscribe = subscribe(
      onEvent,
      () => {
        setConnected(true);
        // Clear pre-disconnect overrides; new SSE statuses can override the snapshot.
        setStatuses({});
        void refreshSessions();
        for (const id of loadedRef.current) void loadThread(id);
      },
      () => setConnected(false),
    );
    const refreshTimer = setInterval(() => { if (!document.hidden) void refreshSessions(); }, 10_000);
    return () => {
      unsubscribe();
      clearInterval(refreshTimer);
      historyRequests.current.clear();
      sessionsRequest.current++;
      setConnected(false);
    };
  }, [authed, onEvent, refreshSessions, loadThread]);

  const statusOf = useCallback(
    (session: SessionSummary): SessionStatus => {
      if (approvals.some((approval) => approval.sessionId === session.id)) return "approval";
      return statuses[session.id] ?? session.status;
    },
    [approvals, statuses],
  );

  return { sessions, errors, agents, approvals, threads, connected, toasts, toast, statusOf, refreshSessions, loadThread };
}

export type Relay = ReturnType<typeof useRelay>;
