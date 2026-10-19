import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Agent, DirListing } from "../../../server/types.ts";
import type { SessionConfig, SessionConfigPatch } from "../../../server/session-config.ts";
import { api, ApiError } from "../api.ts";
import type { Relay } from "../store.ts";
import { AGENT_META, basename, cx, shortPath } from "../util.ts";
import { configSummary, SessionConfiguration } from "./SessionConfiguration.tsx";

type Props = {
  relay: Relay;
  initialCwd: string | null;
  initialAgent?: Agent;
  projectOnly?: boolean;
  onClose: () => void;
  onCreated: (id: string, agent: Agent, cwd: string, text: string) => void;
};

function CreateFolder({ parent, disabled, onPick, onBusyChange }: { parent: string; disabled?: boolean; onPick: (path: string) => void; onBusyChange: (busy: boolean) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const id = useId();
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed !== "." && trimmed !== ".." && !trimmed.includes("/") && !trimmed.includes(String.fromCharCode(92));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onBusyChange(false); };
  }, [onBusyChange]);

  async function createFolder() {
    if (pending.current || disabled) return;
    if (!valid) {
      setError("请输入有效的文件夹名称，不能包含路径分隔符，也不能为 . 或 ..。");
      return;
    }
    pending.current = true;
    onBusyChange(true);
    setBusy(true);
    setError(null);
    try {
      const listing = await api.createDir(parent, trimmed);
      if (mounted.current) {
        setExpanded(false);
        setName("");
        onPick(listing.path);
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof ApiError && failure.status < 500 ? failure.message : "无法创建文件夹，请检查连接后重试。");
    } finally {
      pending.current = false;
      onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }

  if (!expanded) return <button disabled={disabled} onClick={() => setExpanded(true)} className="rounded px-1 py-1 text-xs text-zinc-600 underline disabled:opacity-40 dark:text-zinc-300">＋ 新建子文件夹</button>;
  return (
    <div className="space-y-1.5" aria-busy={busy}>
      <label htmlFor={id} className="block text-xs text-zinc-500">新文件夹名称</label>
      <div className="flex gap-2">
        <input id={id} value={name} disabled={busy || disabled} onChange={(event) => { setName(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void createFolder(); } }}
          aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} placeholder="项目名称"
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-700" />
        <button disabled={busy || disabled || !valid} onClick={() => void createFolder()} className="shrink-0 rounded-lg bg-zinc-900 px-2 text-xs text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{busy ? "创建中…" : "创建并选择"}</button>
        <button disabled={busy} onClick={() => { setExpanded(false); setError(null); }} className="shrink-0 text-xs text-zinc-500">取消</button>
      </div>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!valid && trimmed && !error && <p className="text-xs text-zinc-500">名称不能包含路径分隔符，也不能为 . 或 ..。</p>}
    </div>
  );
}

function FolderBrowser({ start, disabled, onPick, onBusyChange }: { start: string | null; disabled?: boolean; onPick: (path: string) => void; onBusyChange: (busy: boolean) => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [path, setPath] = useState(start);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api.dirs(path, hidden, controller.signal).then((result) => {
      if (!controller.signal.aborted) setListing(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError("无法读取文件夹，请检查权限和连接后重试。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, hidden, reload]);

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700" aria-busy={loading}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-700">
        <button disabled={disabled || loading || !listing?.parent} onClick={() => setPath(listing!.parent)} className="rounded px-1.5 py-0.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">↑ 上级</button>
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-500" title={listing?.path}>{shortPath(listing?.path)}</span>
        <label className="flex shrink-0 items-center gap-1 text-zinc-500">
          <input type="checkbox" checked={hidden} disabled={disabled || loading} onChange={(event) => { setPath(listing?.path ?? path); setHidden(event.target.checked); }} /> 隐藏文件夹
        </label>
      </div>
      {loading && <p role="status" className="px-3 py-2 text-xs text-zinc-500">正在读取文件夹…</p>}
      {error && <p role="alert" className="px-3 py-2 text-xs text-red-600">{error} <button onClick={() => setReload((value) => value + 1)} className="underline">重试</button></p>}
      {!loading && !error && <>
        <div className="scroll-thin max-h-56 overflow-y-auto py-1">
          {listing?.dirs.map((dir) => (
            <button disabled={disabled} key={dir.path} onClick={() => setPath(dir.path)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <span aria-hidden="true" className="text-zinc-400">📁</span><span className="truncate">{dir.name}</span>
            </button>
          ))}
          {listing && listing.dirs.length === 0 && <p className="px-3 py-2 text-xs text-zinc-500">没有子文件夹</p>}
        </div>
        {listing && <div className="space-y-2 border-t border-zinc-200 p-2 dark:border-zinc-700">
          <CreateFolder key={listing.path} parent={listing.path} disabled={disabled} onPick={onPick} onBusyChange={onBusyChange} />
          <button disabled={disabled} onClick={() => onPick(listing.path)} className="w-full rounded-lg bg-zinc-900 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">选择「{basename(listing.path)}」</button>
        </div>}
      </>}
    </div>
  );
}

export function NewSession({ relay, initialCwd, initialAgent, projectOnly = false, onClose, onCreated }: Props) {
  const available = relay.agents.filter((agent) => agent.ok).map((agent) => agent.agent);
  const [agent, setAgent] = useState<Agent>(initialAgent && available.includes(initialAgent) ? initialAgent : available[0] ?? "codex");
  const [cwd, setCwd] = useState<string | null>(initialCwd);
  const [browsing, setBrowsing] = useState(!initialCwd);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState<{ agent: Agent; config: SessionConfig } | null>(null);
  const [draft, setDraft] = useState<SessionConfigPatch>({});
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configReload, setConfigReload] = useState(0);
  const configRequest = useRef<AbortController | null>(null);
  const selectedAgent = useRef(agent);
  const creating = useRef(false);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const dialogTitle = useId();
  const [folderBusy, setFolderBusy] = useState(false);
  const folderPending = useRef(false);
  const onFolderBusy = useCallback((value: boolean) => { folderPending.current = value; setFolderBusy(value); }, []);
  const directoryBusy = busy || folderBusy;

  function pickFolder(path: string) {
    if (creating.current) return;
    setCwd(path);
    setBrowsing(false);
    prompt.current?.focus();
  }

  useEffect(() => {
    const controller = new AbortController();
    configRequest.current = controller;
    setConfiguration(null);
    setDraft({});
    setConfigError(null);
    setConfigLoading(true);
    void api.agentConfiguration(agent, controller.signal).then((config) => {
      if (!controller.signal.aborted && selectedAgent.current === agent) setConfiguration({ agent, config });
    }).catch((error) => {
      if (!controller.signal.aborted && selectedAgent.current === agent) setConfigError(`无法读取默认设置：${(error as Error).message}`);
    }).finally(() => {
      if (!controller.signal.aborted && selectedAgent.current === agent) setConfigLoading(false);
    });
    return () => controller.abort();
  }, [agent, configReload]);

  function chooseAgent(next: Agent) {
    if (creating.current || next === agent) return;
    configRequest.current?.abort();
    selectedAgent.current = next;
    setConfiguration(null);
    setDraft({});
    setConfigError(null);
    setConfigLoading(true);
    setError(null);
    setAgent(next);
  }

  const config = configuration?.agent === agent ? { ...configuration.config, ...draft } : null;
  if (config && draft.permissionMode !== undefined) {
    config.effectivePermissionMode = agent === "pi" && (draft.permissionMode == null || draft.permissionMode === "inherit")
      ? configuration?.config.effectivePermissionMode
      : draft.permissionMode ?? (configuration?.config.permissionMode == null ? configuration?.config.effectivePermissionMode : null);
  }

  const recent = useMemo(() => {
    const seen = new Set<string>();
    for (const session of relay.sessions) {
      if (session.cwd && !session.cwd.includes("/scratch") && !seen.has(session.cwd)) seen.add(session.cwd);
      if (seen.size >= 8) break;
    }
    return [...seen];
  }, [relay.sessions]);

  async function create() {
    if (!cwd || !text.trim() || creating.current || folderPending.current || selectedAgent.current !== agent || !config || configLoading || configError || !available.includes(agent)) return;
    creating.current = true;
    setBusy(true);
    setError(null);
    try {
      const choices: SessionConfigPatch = { model: config.model, thinking: config.thinking, permissionMode: config.permissionMode };
      const { id } = await api.create(agent, cwd, text.trim(), choices);
      onCreated(id, agent, cwd, text.trim());
    } catch (failure) {
      setError(`无法创建会话：${(failure as Error).message}`);
      creating.current = false;
      setBusy(false);
    }
  }

  const ready = Boolean(cwd && text.trim()) && !directoryBusy && available.includes(agent) && Boolean(config) && !configLoading && !configError;

  return (
    <div className={projectOnly ? "scroll-thin h-full overflow-y-auto" : "fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"} onClick={projectOnly ? undefined : onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        role={projectOnly ? "region" : "dialog"} aria-modal={projectOnly ? undefined : true} aria-labelledby={dialogTitle}
        className={projectOnly ? "mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-4 pt-4 sm:pt-6" : "scroll-thin flex max-h-[92dvh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-2xl bg-white px-4 pt-4 shadow-xl sm:rounded-2xl sm:px-5 dark:bg-zinc-900"}
      >
        {!projectOnly && <div aria-hidden="true" className="mx-auto -mt-1 h-1 w-10 shrink-0 rounded-full bg-zinc-300 sm:hidden dark:bg-zinc-700" />}
        <div className="flex items-center gap-2">
          <div className="min-w-0"><h2 id={dialogTitle} className="text-lg font-semibold">新会话</h2>{projectOnly && <p className="truncate text-xs text-zinc-500" title={initialCwd ?? ""}>📁 {shortPath(initialCwd)}</p>}</div>
          <button onClick={onClose} aria-label="关闭新会话" className="ml-auto flex size-10 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">✕</button>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-zinc-500">使用</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {relay.agents.map((entry) => (
              <button
                key={entry.agent}
                disabled={!entry.ok || busy}
                title={entry.reason}
                aria-pressed={agent === entry.agent}
                onClick={() => chooseAgent(entry.agent)}
                className={cx(
                  "flex min-h-10 items-center justify-center gap-1.5 rounded-xl border px-2 text-sm disabled:opacity-35",
                  agent === entry.agent ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800",
                )}
              >
                <span className={cx("size-1.5 shrink-0 rounded-full", AGENT_META[entry.agent].dot)} />
                <span className="truncate">{AGENT_META[entry.agent].label}</span>
              </button>
            ))}
          </div>
        </div>

        {!projectOnly && <div className="space-y-1.5">
          <div className="flex items-center text-xs font-medium text-zinc-500">
            项目文件夹
            {!browsing && (
              <button disabled={directoryBusy} onClick={() => setBrowsing(true)} className="ml-auto min-h-8 rounded-md px-2 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800">浏览…</button>
            )}
          </div>
          {cwd && !browsing && <div className="truncate rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm dark:bg-zinc-800" title={cwd}>📁 {shortPath(cwd)}</div>}
          {cwd && !browsing && <CreateFolder key={cwd} parent={cwd} disabled={busy} onPick={pickFolder} onBusyChange={onFolderBusy} />}
          {!browsing && recent.length > 0 && (
            <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="最近项目">
              {recent.map((path) => (
                <button
                  key={path}
                  title={path}
                  disabled={directoryBusy}
                  aria-pressed={cwd === path}
                  onClick={() => pickFolder(path)}
                  className={cx("min-h-8 shrink-0 rounded-full border px-3 text-xs whitespace-nowrap", cwd === path ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800")}
                >
                  {basename(path)}
                </button>
              ))}
            </div>
          )}
          {browsing && (
            <FolderBrowser
              start={cwd}
              disabled={directoryBusy}
              onPick={pickFolder}
              onBusyChange={onFolderBusy}
            />
          )}
        </div>}

        <div className="space-y-1.5">
          <label htmlFor={`${dialogTitle}-prompt`} className="text-xs font-medium text-zinc-500">第一条消息</label>
          <textarea
            id={`${dialogTitle}-prompt`}
            ref={prompt}
            autoFocus
            disabled={busy}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void create();
              }
            }}
            rows={projectOnly ? 5 : 4}
            placeholder="要做什么？"
            className="w-full resize-none rounded-xl border border-zinc-200 bg-transparent px-3 py-2 text-base outline-none focus:border-zinc-400 sm:text-[15px] dark:border-zinc-700"
          />
        </div>

        <details className="group rounded-xl border border-zinc-200 dark:border-zinc-800" open={Boolean(configError)}>
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-xs text-zinc-500 select-none [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true">⚙</span>
            <span className="font-medium text-zinc-600 dark:text-zinc-300">模型与权限</span>
            <span className="min-w-0 flex-1 truncate">{configLoading ? "读取中…" : config ? configSummary(config).text : ""}</span>
            <span aria-hidden="true" className="text-zinc-400 transition-transform group-open:rotate-180">▾</span>
          </summary>
          <div className="space-y-2 px-3 pb-3" aria-busy={configLoading}>
            {config && <SessionConfiguration config={config} disabled={busy || configLoading} onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))} />}
            {configLoading && <p role="status" className="text-xs text-zinc-500">正在读取默认设置…</p>}
          </div>
        </details>
        {configError && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {configError} <button onClick={() => { setConfigLoading(true); setConfigError(null); setConfigReload((value) => value + 1); }} className="underline">重试</button>
          </p>
        )}

        {error && <p role="alert" className="text-sm break-words text-red-600 dark:text-red-400">{error}</p>}
        <div className={cx("sticky bottom-0 -mx-4 mt-auto border-t border-zinc-100 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),1rem)] dark:border-zinc-800", projectOnly ? "bg-white dark:bg-zinc-900" : "bg-white sm:-mx-5 sm:px-5 dark:bg-zinc-900")}>
          <button
            onClick={() => void create()}
            disabled={!ready || busy}
            className="min-h-12 w-full rounded-xl bg-zinc-900 font-medium text-white hover:bg-zinc-700 disabled:opacity-35 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {busy ? "发送中…" : projectOnly ? "发送" : "开始"}
          </button>
          {!cwd && !projectOnly && <p className="mt-1.5 text-center text-[11px] text-zinc-500">先选择项目文件夹</p>}
        </div>
      </div>
    </div>
  );
}
