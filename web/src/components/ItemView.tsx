import { memo, useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { ImageInfo, Item } from "../../../server/types.ts";
import { cx } from "../util.ts";

function ImagePreview({ src, alt }: ImageInfo) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) return <span className="block rounded-lg border border-zinc-200 p-3 text-xs text-zinc-500 dark:border-zinc-700">图片暂不可用：{alt || "生成图片"}</span>;
  return <a href={src} target="_blank" rel="noreferrer" className="block min-w-0" aria-label={`打开图片：${alt || "生成图片"}`}><img src={src} alt={alt || "生成图片"} loading="lazy" onError={() => setFailed(true)} className="max-h-[65dvh] max-w-full rounded-xl border border-zinc-200 object-contain dark:border-zinc-700" /></a>;
}
function Images({ images }: { images?: ImageInfo[] }) {
  if (!images?.length) return null;
  return <div className="my-2 grid min-w-0 gap-2">{images.map((image, index) => <ImagePreview key={`${index}:${image.src.slice(0,160)}`} {...image} />)}</div>;
}
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} urlTransform={(url) => /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(url) ? url : defaultUrlTransform(url)} components={{
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    img: ({ src, alt }) => typeof src === "string" ? <ImagePreview src={src} alt={alt} /> : null,
    p: ({ children }) => <div className="my-2">{children}</div>,
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
function ToolView({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const tool = item.tool!;
  useEffect(() => { if (tool.status === "error" || tool.status === "denied") setOpen(true); }, [tool.status]);
  const isFileEdit = /^(?:edit|multiedit|write|apply_patch|fileChange)$/i.test(tool.name) || tool.additions != null || tool.deletions != null;
  const summary = (tool.input ?? "").split("\n")[0];
  const hasMore = Boolean(tool.output) || (tool.input ?? "").includes("\n") || Boolean(tool.files?.length);
  const label = tool.status === "running" ? "运行中" : tool.status === "ok" ? "已完成" : tool.status === "error" ? "失败" : tool.status === "denied" ? "已拒绝" : "状态未知";
  return <div className="min-w-0 text-[13px]">
    <button onClick={() => hasMore && setOpen(!open)} aria-expanded={open} className={cx("flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 text-left text-zinc-600 dark:text-zinc-400", hasMore && "hover:bg-zinc-100 dark:hover:bg-zinc-800/70")}>
      <ToolIcon status={tool.status} />
      <span className="shrink-0 font-medium text-zinc-800 dark:text-zinc-200">{tool.name}</span>
      <span className="shrink-0 text-[11px]">{label}</span>
      <DiffCount additions={tool.additions} deletions={tool.deletions} />
      {!isFileEdit && tool.durationMs != null && <span className="text-[11px] text-zinc-400">{tool.durationMs < 1000 ? `${Math.round(tool.durationMs)}ms` : `${(tool.durationMs/1000).toFixed(1)}s`}</span> }
      {tool.exitCode != null && <span className={cx("text-[11px]", tool.exitCode ? "text-red-500" : "text-zinc-400")}>退出 {tool.exitCode}</span>}
      {hasMore && <span className="ml-auto shrink-0 text-zinc-400">{open ? "▾" : "▸"}</span>}
      {summary && <span className="w-full truncate pl-5 font-mono text-xs">{summary}</span>}
    </button>
    {open && <div className="mt-1 ml-5 min-w-0 space-y-2">
      {tool.files?.map((file) => <div key={file.path} className="flex min-w-0 items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span><DiffCount {...file} /></div>)}
      {tool.input && <pre className="scroll-thin max-h-60 overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-xs whitespace-pre-wrap break-words dark:bg-zinc-800/80">{tool.input}</pre>}
      {tool.output && <pre className="scroll-thin max-h-80 overflow-auto rounded-md bg-zinc-950 p-2 font-mono text-xs whitespace-pre-wrap break-words text-zinc-200">{tool.output}</pre>}
    </div>}
    <Images images={item.images} />
  </div>;
}
function Reasoning({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  return <div className="text-[13px] text-zinc-500"><button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-8 items-center gap-1 rounded-md px-2 hover:bg-zinc-100 dark:hover:bg-zinc-800/70"><span>{open ? "▾" : "▸"}</span> 思考过程</button>{open && <div className="mt-1 ml-5 border-l-2 border-zinc-200 pl-3 whitespace-pre-wrap dark:border-zinc-700">{item.text}</div>}</div>;
}
export const ItemView = memo(function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user": return <div className="flex justify-end"><div className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap break-words dark:bg-zinc-800">{item.text}<Images images={item.images} /></div></div>;
    case "assistant": return <div className={cx("md min-w-0", item.streaming && "caret")}><Markdown text={item.text} /><Images images={item.images} /></div>;
    case "reasoning": return <Reasoning item={item} />;
    case "tool": return <ToolView item={item} />;
    case "error": return <div role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm whitespace-pre-wrap break-words text-red-700 dark:text-red-300">{item.text}</div>;
    default: return <div className="min-w-0 px-2 text-xs whitespace-pre-wrap text-zinc-500">{item.text}<Images images={item.images} /></div>;
  }
});
