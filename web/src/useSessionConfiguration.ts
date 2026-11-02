import { useEffect, useRef, useState } from "react";
import type { SessionConfig, SessionConfigPatch } from "../../server/session-config.ts";
import { api, ApiError } from "./api.ts";

type State = { id: string; agent: string; config: SessionConfig | null; loading: boolean; saving: boolean; error: string | null };
type Scope = { id: string; agent: string; disposed: boolean; saving: boolean; read: AbortController | null; refreshAfterSave: boolean; refresh: (force?: boolean) => Promise<void> };

export function useSessionConfiguration(id: string, agent: string, running: boolean, sending = false) {
  const [state, setState] = useState<State>({ id, agent, config: null, loading: true, saving: false, error: null });
  const current = useRef<Scope | null>(null);
  const blocked = useRef(running || sending);
  blocked.current = running || sending;

  useEffect(() => {
    const scope: Scope = { id, agent, disposed: false, saving: false, read: null, refreshAfterSave: false, refresh: async () => {} };
    current.current = scope;
    setState({ id, agent, config: null, loading: true, saving: false, error: null });
    scope.refresh = async (force = false) => {
      if (scope.disposed) return;
      if (scope.saving) {
        if (force) scope.refreshAfterSave = true;
        return;
      }
      // At most one read at a time; a save invalidates even an already resolved read.
      if (scope.read && !force) return;
      scope.read?.abort();
      const controller = new AbortController();
      scope.read = controller;
      try {
        const config = await api.sessionConfiguration(id, controller.signal);
        if (!scope.disposed && scope.read === controller && !controller.signal.aborted && !scope.saving) {
          setState({ id, agent, config, loading: false, saving: false, error: null });
        }
      } catch (error) {
        if (!scope.disposed && scope.read === controller && !controller.signal.aborted) {
          setState((previous) => ({ ...previous, loading: false, error: `无法读取会话设置：${(error as Error).message}` }));
        }
      } finally {
        if (scope.read === controller) scope.read = null;
      }
    };
    void scope.refresh();
    const timer = agent === "pi" || agent === "pi-native" ? setInterval(() => void scope.refresh(), 5000) : undefined;
    return () => {
      scope.disposed = true;
      scope.read?.abort();
      if (timer) clearInterval(timer);
      if (current.current === scope) current.current = null;
    };
  }, [id, agent]);

  const previousTurn = useRef({ id, agent, running });
  useEffect(() => {
    if (previousTurn.current.id === id && previousTurn.current.agent === agent && previousTurn.current.running && !running) void current.current?.refresh(true);
    previousTurn.current = { id, agent, running };
  }, [id, agent, running]);

  async function save(patch: SessionConfigPatch) {
    const scope = current.current;
    if (!scope || scope.id !== id || scope.agent !== agent || scope.disposed || scope.saving || blocked.current) return;
    scope.saving = true;
    scope.read?.abort();
    scope.read = null;
    setState((previous) => ({ ...previous, saving: true, error: null }));
    try {
      const config = await api.updateSessionConfiguration(id, patch);
      if (!scope.disposed) setState({ id, agent, config, loading: false, saving: false, error: null });
    } catch (error) {
      if (!scope.disposed) {
        const message = error instanceof ApiError && error.status === 409 ? `任务运行或等待审批中：${error.message}` : `设置未能保存：${(error as Error).message}`;
        setState((previous) => ({ ...previous, saving: false, error: message }));
      }
    } finally {
      scope.saving = false;
      if (!scope.disposed && scope.refreshAfterSave) {
        scope.refreshAfterSave = false;
        void scope.refresh();
      }
    }
  }

  const visible = state.id === id && state.agent === agent ? state : { id, agent, config: null, loading: true, saving: false, error: null };
  const activeScope = () => current.current?.id === id && current.current.agent === agent ? current.current : null;
  return { ...visible, save, refresh: () => void activeScope()?.refresh(true), isSaving: () => activeScope()?.saving ?? false };
}
