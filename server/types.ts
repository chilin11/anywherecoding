// Shared wire types between the relay server and the web client.

export type Agent = "codex" | "claude" | "pi" | "pi-native" | "botsteam";

export const AGENTS: readonly Agent[] = ["codex", "claude", "pi", "pi-native", "botsteam"];

/** A backend-owned conversation target, independent of models/providers. */
export type SessionTarget = {
  id: string;
  kind: "team" | "bot";
  label: string;
  description?: string;
  directory: "required" | "optional";
};

export type SessionStatus = "idle" | "running" | "approval" | "unknown";

export type SessionSummary = {
  /** `${agent}:${nativeId}` */
  id: string;
  agent: Agent;
  nativeId: string;
  title: string;
  cwd: string | null;
  /** Optional project identity and display label where a path alone is ambiguous. */
  projectKey?: string;
  projectLabel?: string;
  /** False when cwd cannot safely identify a project for path-based creation. */
  createInProject?: boolean;
  /** Unix ms. */
  updatedAt: number;
  status: SessionStatus;
  target?: SessionTarget;
  actions?: { rename: boolean; remove: boolean };
};

export type ItemKind = "user" | "assistant" | "reasoning" | "tool" | "system" | "error";

export type ToolInfo = {
  name: string;
  input?: string;
  output?: string;
  status?: "running" | "ok" | "error" | "denied";
  exitCode?: number;
  durationMs?: number;
  additions?: number;
  deletions?: number;
  files?: { path: string; additions: number; deletions: number }[];
};

export type ImageInfo = { src: string; alt?: string };

export type Item = {
  id: string;
  kind: ItemKind;
  text: string;
  /** Unix ms, when known. */
  ts?: number;
  tool?: ToolInfo;
  streaming?: boolean;
  images?: ImageInfo[];
  speaker?: { id: string; name: string };
  taskId?: string;
  /** Root task ID for items belonging to a child task. */
  parentTaskId?: string;
  runId?: string;
};

export type History = {
  items: Item[];
  /** Opaque cursor for older items; null when the start was reached. */
  before: string | null;
};

export type ApprovalChoice = {
  id: string;
  label: string;
  tone?: "primary" | "danger" | "default";
};

export type ApprovalQuestion = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  allowOther: boolean;
  multiSelect?: boolean;
};

export type Approval = {
  id: string;
  sessionId: string;
  agent: Agent;
  title: string;
  detail: string;
  choices: ApprovalChoice[];
  /** Present when the agent asks questions instead of a yes/no decision. */
  questions?: ApprovalQuestion[];
  createdAt: number;
};

export type ApprovalAnswer = {
  choice: string;
  /** questionId -> answers, for question-style approvals. */
  answers?: Record<string, string[]>;
};

export type AgentAvailability = {
  agent: Agent;
  ok: boolean;
  reason?: string;
  /** A usable connection with a known limitation the user should see. */
  warning?: string;
};

export type Connection = AgentAvailability & { enabled: boolean; label: string };

export type RelayEvent =
  | { type: "hello"; approvals: Approval[]; agents: AgentAvailability[] }
  | { type: "sessions" }
  | { type: "item"; sessionId: string; item: Item }
  | { type: "delta"; sessionId: string; itemId: string; text: string }
  | { type: "itemRemoved"; sessionId: string; itemId: string }
  | { type: "status"; sessionId: string; status: SessionStatus }
  | { type: "approval"; approval: Approval }
  | { type: "approvalResolved"; id: string }
  | { type: "notice"; sessionId?: string; level: "info" | "error"; message: string };

export type DirEntry = { name: string; path: string };

export type DirListing = { path: string; parent: string | null; dirs: DirEntry[] };
