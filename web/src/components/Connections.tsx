import { useEffect, useRef, useState } from "react";
import type { Agent, Connection } from "../../../server/types.ts";
import { api } from "../api.ts";
import { AGENT_META, cx } from "../util.ts";
import type { Relay } from "../store.ts";

const HELP: Record<Agent, string> = {
  codex: "连接本机 Codex CLI，读取并继续原生线程。",
  claude: "连接 Claude Code CLI，读取 Claude Code / Claude.app 原生会话。",
  pi: "连接正在运行的 PI-Desktop，需启用桌面 MCP 控制口。",
  "pi-native": "连接原生 Pi CLI，使用本机 Pi 配置和会话，无需 PI-Desktop。",
};

export function ConnectionsPanel({ relay, onClose }: { relay: Relay; onClose: () => void }) {
  const [entries, setEntries] = useState<Connection[]>([]);
  const [results, setResults] = useState<Partial<Record<Agent, { ok: boolean; reason?: string }>>>({});
  const [busy, setBusy] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let alive = true; void api.connections().then((data) => { if (alive) setEntries(data.connections); }).catch((failure) => { if (alive) setError(failure.message); }); return () => { alive = false; }; }, []);
  const pending = useRef(false);
  async function act(entry: Connection, action: "detect" | "add" | "remove") {
    if (pending.current) return;
    pending.current = true;
    setBusy(entry.agent); setError(null);
    try {
      if (action === "detect") {
        const result = await api.detectConnection(entry.agent);
        setResults((all) => ({ ...all, [entry.agent]: result }));
      } else {
        const result = await (action === "add" ? api.addConnection(entry.agent) : api.removeConnection(entry.agent));
        setEntries(result.connections);
        setResults((all) => ({ ...all, [entry.agent]: undefined }));
        await relay.refreshSessions();
      }
    } catch (failure) { setResults((all) => ({ ...all, [entry.agent]: { ok: false, reason: (failure as Error).message } })); }
    finally { pending.current = false; setBusy(null); }
  }
  return <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => { if (!pending.current) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="connections-title" onClick={(event) => event.stopPropagation()} className="scroll-thin max-h-[92dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] shadow-xl sm:rounded-2xl dark:bg-zinc-900">
      <header className="flex items-center gap-2"><h2 id="connections-title" className="text-lg font-semibold">连接的 IDE</h2><button onClick={onClose} disabled={busy != null} aria-label="关闭连接管理" className="ml-auto rounded px-2 text-zinc-500 disabled:opacity-40">✕</button></header>
      <p className="text-xs text-zinc-500">选择本机客户端并添加。检测不会发送模型消息。移除连接会保留原生会话。</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!entries.length && !error && <p role="status" className="text-sm text-zinc-500">正在读取连接…</p>}
      {entries.map((entry) => {
        const result = results[entry.agent];
        return <article key={entry.agent} className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
          <div className="flex items-center gap-2"><span className={cx("size-2 rounded-full", AGENT_META[entry.agent].dot)} /><h3 className="text-sm font-medium">{entry.label}</h3><span className="ml-auto text-xs text-zinc-500">{entry.enabled ? entry.ok ? "已连接" : "连接不可用" : "未添加"}</span></div>
          <p className="text-xs text-zinc-500">{HELP[entry.agent]}</p>
          {entry.enabled && !entry.ok && <p className="break-words text-xs text-amber-600">{entry.reason}</p>}
          {result && <p role={result.ok ? "status" : "alert"} className={cx("break-words text-xs", result.ok ? "text-emerald-600" : "text-amber-600")}>{result.ok ? "检测到可用客户端" : `未检测到可用连接：${result.reason}`}</p>}
          <div className="flex justify-end gap-3 text-xs">
            <button disabled={busy != null} onClick={() => void act(entry, "detect")} className="rounded px-2 py-1.5 text-zinc-600 underline disabled:opacity-40 dark:text-zinc-300">重新检测</button>
            {entry.enabled && <button disabled={busy != null} onClick={() => void act(entry, "remove")} className="rounded px-2 py-1.5 text-red-600 disabled:opacity-40">移除</button>}
            {(!entry.enabled || !entry.ok) && <button disabled={busy != null} onClick={() => void act(entry, "add")} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{busy === entry.agent ? "检测中…" : entry.enabled ? "重新连接" : "检测并添加"}</button>}
          </div>
        </article>;
      })}
    </section>
  </div>;
}
