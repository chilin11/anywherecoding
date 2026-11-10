import { useId } from "react";
import type { ConfigOption, ModelOption, SessionConfig, SessionConfigPatch } from "../../../server/session-config.ts";

type Props = {
  config: SessionConfig;
  disabled?: boolean;
  onChange: (patch: SessionConfigPatch) => void;
  showContext?: boolean;
};

// Only submit native option values supplied by the server.
export function modelChange(model: ModelOption | undefined): SessionConfigPatch {
  const thinking = model?.defaultThinking;
  return {
    model: model?.value ?? null,
    thinking: thinking != null && model?.thinkingLevels.some((option) => option.value === thinking) ? thinking : null,
  };
}

function ConfigSelect({ label, value, options, disabled, onChange }: {
  label: string;
  value: string | null;
  options: ConfigOption[];
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const id = useId();
  const selected = options.find((option) => option.value === value);
  const description = selected?.description;
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-xs text-zinc-500">{label}</label>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        aria-describedby={description ? `${id}-description` : undefined}
        className="min-h-9 w-full min-w-0 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">继承默认</option>
        {value != null && !selected && <option value={value}>{value}（当前）</option>}
        {options.map((option) => <option key={option.value} value={option.value} title={option.description}>{option.label}</option>)}
      </select>
      {description && <p id={`${id}-description`} className="break-words text-[11px] leading-4 text-zinc-500">{description}</p>}
    </div>
  );
}

function ContextUsage({ context }: { context: NonNullable<SessionConfig["context"]> }) {
  const used = context.usedTokens != null && Number.isFinite(context.usedTokens) && context.usedTokens >= 0 ? context.usedTokens : null;
  const window = context.windowTokens != null && Number.isFinite(context.windowTokens) && context.windowTokens > 0 ? context.windowTokens : null;
  const percent = used != null && window != null ? used / window * 100 : null;
  const format = (value: number | null) => value == null ? "未知" : value.toLocaleString();
  const description = `上下文：${format(used)} / ${format(window)} tokens；来源：${context.source || "未知"}`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500" title={description} aria-label={description}>
      <span>上下文 {percent == null ? "未知" : `${percent < 1 && percent > 0 ? "<1" : Math.round(percent)}%`}</span>
      <span>{format(used)} / {format(window)} tokens</span>
      {percent != null && <progress className="h-1.5 w-16 accent-blue-500" max={100} value={Math.min(percent, 100)} aria-label="上下文使用率" />}
    </div>
  );
}

/** One-line description of the effective choices, for the collapsed settings button. */
export function configSummary(config: SessionConfig): { text: string; context: string | null } {
  const model = config.models.find((option) => option.value === config.model);
  const thinking = model?.thinkingLevels.find((option) => option.value === config.thinking);
  const permission = config.permissionModes.find((option) => option.value === config.permissionMode);
  const parts = [
    config.model == null ? "默认模型" : model?.label ?? config.model,
    config.thinking == null ? null : thinking?.label ?? config.thinking,
    config.permissionModes.length === 0 ? null : config.permissionMode == null ? "默认权限" : permission?.label ?? config.permissionMode,
  ].filter(Boolean);
  const used = config.context?.usedTokens;
  const window = config.context?.windowTokens;
  const context = used != null && window != null && used >= 0 && window > 0 ? `${used / window * 100 < 1 && used > 0 ? "<1" : Math.round(used / window * 100)}%` : null;
  return { text: parts.join(" · "), context };
}

export function SessionConfiguration({ config, disabled, onChange, showContext }: Props) {
  const model = config.models.find((option) => option.value === config.model);
  const levels = model?.thinkingLevels ?? [];
  const effective = config.permissionModes.find((option) => option.value === config.effectivePermissionMode)?.label ?? config.effectivePermissionMode ?? "未知";
  return (
    <div className="space-y-2" aria-label="会话设置">
      <div className="grid grid-cols-2 items-start gap-2 sm:grid-cols-3">
        <ConfigSelect label="模型" value={config.model} options={config.models} disabled={disabled} onChange={(value) => onChange(modelChange(config.models.find((option) => option.value === value)))} />
        <ConfigSelect label="思考程度" value={config.thinking} options={levels} disabled={disabled || (levels.length === 0 && config.thinking == null)} onChange={(thinking) => onChange({ thinking })} />
        {config.permissionModes.length > 0 && <ConfigSelect label="权限模式" value={config.permissionMode} options={config.permissionModes} disabled={disabled} onChange={(permissionMode) => onChange({ permissionMode })} />}
      </div>
      {config.permissionModes.length > 0 && <p className="text-[11px] text-zinc-500">{config.permissionMode == null ? "权限继承默认" : `当前权限：${config.permissionModes.find((option) => option.value === config.permissionMode)?.label ?? config.permissionMode}`} · 实际权限：{effective}</p>}
      {config.notice && <p className="text-xs text-zinc-500">{config.notice}</p>}
      {showContext && config.context && <ContextUsage context={config.context} />}
    </div>
  );
}
