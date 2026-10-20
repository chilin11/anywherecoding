import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Hub, type Adapter } from "./hub.ts";
import { AGENTS, type Agent, type AgentAvailability, type Connection } from "./types.ts";

export const CONNECTION_LABELS: Record<Agent, string> = { codex: "Codex", claude: "Claude Code", pi: "PI-Desktop", "pi-native": "Pi CLI" };
export function parseAgent(value: unknown): Agent {
  if (!AGENTS.includes(value as Agent)) throw Object.assign(new Error("未知连接类型"), { status: 400 });
  return value as Agent;
}

/** Only explicitly added connections own adapters; detection uses a disposable instance. */
export class Connections {
  readonly adapters = new Map<Agent, Adapter>();
  private enabled = new Set<Agent>();
  private failures = new Map<Agent, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  private hub: Hub;
  private factory: (agent: Agent, hub: Hub) => Adapter;
  constructor(file: string, hub: Hub, factory: (agent: Agent, hub: Hub) => Adapter) {
    this.file = file; this.hub = hub; this.factory = factory;
    if (existsSync(file)) {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(value.enabled) || value.enabled.some((agent: unknown) => !AGENTS.includes(agent as Agent))) throw new Error("连接配置无效，请检查 connections.json");
      this.enabled = new Set(value.enabled);
    }
    for (const agent of this.enabled) this.adapters.set(agent, factory(agent, hub));
  }
  private save(enabled: Set<Agent>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".tmp";
    writeFileSync(temp, JSON.stringify({ enabled: [...enabled] }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, this.file);
    this.enabled = enabled;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  availability(): AgentAvailability[] {
    return [...this.adapters].map(([agent, adapter]) => this.failures.has(agent)
      ? { agent, ok: false, reason: this.failures.get(agent) } : adapter.availability());
  }
  list(): Connection[] {
    return AGENTS.map((agent) => ({ agent, label: CONNECTION_LABELS[agent], enabled: this.enabled.has(agent),
      ...(this.availability().find((entry) => entry.agent === agent) ?? { ok: false, reason: "尚未添加" }) }));
  }
  private async verify(adapter: Adapter, start = true): Promise<AgentAvailability> {
    try {
      if (start) await adapter.start();
      // Catalog discovery validates the real protocol without sending a model prompt.
      await adapter.configuration(null);
      return adapter.availability();
    } catch (error) { return { agent: adapter.agent, ok: false, reason: (error as Error).message }; }
  }
  async detect(agent: Agent): Promise<AgentAvailability> {
    const adapter = this.factory(agent, new Hub());
    try { return await this.verify(adapter); } finally { await adapter.stop(); }
  }
  async start(): Promise<void> {
    await Promise.all([...this.adapters].map(async ([agent, adapter]) => {
      const result = await this.verify(adapter);
      if (!result.ok) this.failures.set(agent, result.reason ?? "连接不可用");
    }));
  }
  add(agent: Agent): Promise<void> {
    return this.serial(async () => {
      if (this.enabled.has(agent)) {
        const result = await this.verify(this.adapters.get(agent)!, false);
        if (!result.ok) throw Object.assign(new Error(result.reason ?? "连接不可用"), { status: 400 });
        this.failures.delete(agent); this.hub.sessionsChanged(); return;
      }
      const adapter = this.factory(agent, this.hub);
      const result = await this.verify(adapter);
      if (!result.ok) { await adapter.stop(); throw Object.assign(new Error(result.reason ?? "未检测到可用连接"), { status: 400 }); }
      try { this.save(new Set([...this.enabled, agent])); } catch (error) { await adapter.stop(); throw error; }
      this.adapters.set(agent, adapter); this.failures.delete(agent); this.hub.sessionsChanged();
    });
  }
  remove(agent: Agent): Promise<void> {
    return this.serial(async () => {
      if (!this.enabled.has(agent)) return;
      if (agent !== "pi" && this.hub.busy(agent)) throw Object.assign(new Error("该连接仍有任务运行或等待审批，请结束后移除"), { status: 409 });
      const adapter = this.adapters.get(agent)!;
      this.save(new Set([...this.enabled].filter((entry) => entry !== agent)));
      this.adapters.delete(agent); this.failures.delete(agent);
      await adapter.stop(); this.hub.clearAgent(agent);
    });
  }
}
