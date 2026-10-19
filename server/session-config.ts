export type ConfigOption = { value: string; label: string; description?: string };
export type ModelOption = ConfigOption & { thinkingLevels: ConfigOption[]; defaultThinking?: string | null; contextWindow?: number };
export type SessionConfigPatch = { model?: string | null; thinking?: string | null; permissionMode?: string | null };
export type SessionConfig = {
  model: string | null;
  thinking: string | null;
  permissionMode: string | null;
  models: ModelOption[];
  permissionModes: ConfigOption[];
  context?: { usedTokens: number | null; windowTokens: number | null; source: string };
  effectivePermissionMode?: string | null;
  notice?: string;
};

export function invalidConfig(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

export function validateConfigPatch(patch: SessionConfigPatch, config: SessionConfig): void {
  if (patch.model != null && !config.models.some((option) => option.value === patch.model)) throw invalidConfig("模型不可用，请刷新后重试");
  const model = config.models.find((option) => option.value === (patch.model === undefined ? config.model : patch.model));
  if (patch.thinking != null && !model?.thinkingLevels.some((option) => option.value === patch.thinking)) throw invalidConfig("该模型不支持此思考程度");
  if (patch.permissionMode != null && !config.permissionModes.some((option) => option.value === patch.permissionMode)) throw invalidConfig("权限模式不可用");
}

export function parseConfigPatch(value: unknown): SessionConfigPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidConfig("会话配置格式无效");
  const allowed = ["model", "thinking", "permissionMode"];
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key) || (entry !== null && (typeof entry !== "string" || entry.length > 1000))) throw invalidConfig("会话配置字段无效");
  }
  return value as SessionConfigPatch;
}
