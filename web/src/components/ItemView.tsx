import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { ImageInfo, Item } from "../../../server/types.ts";
import { copyText, cx, isTouch } from "../util.ts";

function ImagePreview({ src, alt }: ImageInfo) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) return <span className="block rounded-lg border border-zinc-200 p-3 text-xs text-zinc-500 dark:border-zinc-700">图片暂不可用：{alt || "生成图片"}</span>;
  return <a href={src} target="_blank" rel="noreferrer" className="block min-w-0" aria-label={`打开图片：${alt || "生成图片"}`}><img src={src} alt={alt || "生成图片"} loading="lazy" onError={() => setFailed(true)} className="max-h-[40dvh] max-w-full rounded-md border border-zinc-200 object-contain sm:max-w-[min(100%,640px)] dark:border-zinc-700" /></a>;
}
function Images({ images }: { images?: ImageInfo[] }) {
  if (!images?.length) return null;
  return <div className="my-1.5 grid min-w-0 justify-items-start gap-1.5">{images.map((image, index) => <ImagePreview key={`${index}:${image.src.slice(0,160)}`} {...image} />)}</div>;
}
function CopyButton({ text, label = "复制", className, iconOnly }: { text: () => string; label?: string; className?: string; iconOnly?: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      onClick={() => copyText(text()).then(() => setState("done"), () => setState("failed"))}
      aria-label={state === "done" ? "已复制" : label}
      className={cx("inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-xs text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200", className)}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
        {state === "done" ? <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" /> : <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.75A1.25 1.25 0 0 0 9.25 2.5h-5.5A1.25 1.25 0 0 0 2.5 3.75v5.5a1.25 1.25 0 0 0 1.25 1.25H5.5" /></>}
      </svg>
      {!iconOnly && (state === "done" ? "已复制" : state === "failed" ? "复制失败" : label)}
    </button>
  );
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group/code relative">
      <pre ref={ref}>{children}</pre>
      <CopyButton text={() => ref.current?.textContent ?? ""} className={cx("absolute top-1 right-1 bg-zinc-100/90 dark:bg-zinc-800/90", !isTouch && "opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100")} />
    </div>
  );
}
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} urlTransform={(url) => /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(url) ? url : defaultUrlTransform(url)} components={{
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    img: ({ src, alt }) => typeof src === "string" ? <ImagePreview src={src} alt={alt} /> : null,
    p: ({ children }) => <div>{children}</div>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  }}>{text}</ReactMarkdown>;
});

function ToolIcon({ status }: { status?: string }) {
  if (status === "running") return <span className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-500" />;
  if (status === "error") return <span className="text-red-500">✕</span>;
  if (status === "denied") return <span className="text-amber-500">⊘</span>;
  if (status === "ok") return <span className="text-emerald-500">✓</span>;
  return <span className="text-zinc-400">○</span>;
}
function DiffCount({ additions, deletions }: { additions?: number; deletions?: number }) {
  if (additions === undefined && deletions === undefined) return null;
  return <span className="inline-flex shrink-0 gap-1.5 font-mono text-xs" aria-label={`新增 ${additions ?? 0} 行，删除 ${deletions ?? 0} 行`}><span className="text-emerald-600 dark:text-emerald-400">+{additions ?? 0}</span><span className="text-red-500 dark:text-red-400">−{deletions ?? 0}</span></span>;
}
function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
/** One dense log-style row per tool call; details expand inline like an IDE output panel. */
function ToolView({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const tool = item.tool!;
  useEffect(() => { if (tool.status === "error" || tool.status === "denied") setOpen(true); }, [tool.status]);
  const isFileEdit = /^(?:edit|multiedit|write|apply_patch|fileChange)$/i.test(tool.name) || tool.additions != null || tool.deletions != null;
  const summary = (tool.input ?? "").split("\n").find((line) => line.trim()) ?? "";
  const hasMore = Boolean(tool.output) || (tool.input ?? "").trim().includes("\n") || Boolean(tool.files?.length);
  const label = tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : tool.status === "denied" ? "已拒绝" : tool.status === "ok" ? "" : "状态未知";
  return <div className="min-w-0 text-[12.5px] leading-5">
    <button onClick={() => hasMore && setOpen(!open)} aria-expanded={open} aria-label={`${tool.name} ${label || "已完成"}`} className={cx("flex w-full min-w-0 items-center gap-1.5 rounded px-1 text-left text-zinc-600 dark:text-zinc-400", isTouch ? "min-h-6" : "min-h-[22px]", hasMore && "hover:bg-zinc-100 dark:hover:bg-zinc-800/70")}>
      <ToolIcon status={tool.status} />
      <span className="shrink-0 font-medium text-zinc-800 dark:text-zinc-200">{tool.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-500" title={summary}>{summary}</span>
      {label && <span className={cx("shrink-0 text-[11px]", tool.status === "error" ? "text-red-500" : tool.status === "denied" ? "text-amber-600" : "text-zinc-400")}>{label}</span>}
      <DiffCount additions={tool.additions} deletions={tool.deletions} />
      {tool.exitCode != null && tool.exitCode !== 0 && <span className="shrink-0 text-[11px] text-red-500">exit {tool.exitCode}</span>}
      {!isFileEdit && tool.durationMs != null && tool.durationMs > 0 && <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{duration(tool.durationMs)}</span>}
      {hasMore && <span aria-hidden="true" className="w-3 shrink-0 text-center text-zinc-400">{open ? "▾" : "▸"}</span>}
    </button>
    {open && <div className="mt-0.5 mb-1 ml-5 min-w-0 space-y-1">
      {tool.files?.map((file) => <div key={file.path} className="flex min-w-0 items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span><DiffCount {...file} /></div>)}
      {tool.input && <pre className="scroll-thin max-h-60 overflow-auto rounded border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap break-words dark:border-zinc-800 dark:bg-zinc-900">{tool.input}</pre>}
      {tool.output && <pre className="scroll-thin max-h-80 overflow-auto rounded bg-zinc-950 px-2 py-1 font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap break-words text-zinc-200">{tool.output}</pre>}
    </div>}
    <Images images={item.images} />
  </div>;
}
function Reasoning({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  return <div className="text-[11.5px] leading-5 text-zinc-400"><button onClick={() => setOpen(!open)} aria-expanded={open} aria-label="思考过程" className={cx("flex items-center gap-1.5 rounded px-1 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800/70", isTouch ? "min-h-6" : "min-h-5")}><span aria-hidden="true" className="w-3 text-center">{open ? "▾" : "▸"}</span>思考</button>{open && <div className="mt-0.5 mb-1 ml-5 border-l-2 border-zinc-200 pl-2.5 text-zinc-500 whitespace-pre-wrap dark:border-zinc-700">{item.text}</div>}</div>;
}
export const ItemView = memo(function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user": return <div className="flex justify-end pt-1.5 pb-0.5"><div className="max-w-[88%] rounded-md bg-zinc-100 px-2.5 py-1 text-[13.5px] leading-[1.6] whitespace-pre-wrap break-words dark:bg-zinc-800">{item.text}<Images images={item.images} /></div></div>;
    case "assistant": return <div className="group/msg relative min-w-0 py-0.5">
      <div className={cx("md min-w-0", isTouch && "pr-6", item.streaming && "caret")}><Markdown text={item.text} /><Images images={item.images} /></div>
      {!item.streaming && item.text.trim() && <div className={cx("absolute -top-1 right-0", !isTouch && "opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100")}><CopyButton text={() => item.text} iconOnly={isTouch} className={cx("bg-white/90 dark:bg-zinc-900/90", isTouch && "min-h-6 px-1 text-zinc-400")} /></div>}
    </div>;
    case "reasoning": return <Reasoning item={item} />;
    case "tool": return <ToolView item={item} />;
    case "error": return <div role="alert" className="rounded bg-red-500/10 px-2 py-1 text-[12.5px] leading-5 whitespace-pre-wrap break-words text-red-700 dark:text-red-300">{item.text}</div>;
    default: return <div className="min-w-0 px-1 text-[11.5px] leading-5 whitespace-pre-wrap text-zinc-500">{item.text}<Images images={item.images} /></div>;
  }
});
