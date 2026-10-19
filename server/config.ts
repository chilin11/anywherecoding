import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  host: string;
  port: number;
  /** Login token typed into the web page. */
  token: string;
  /** HMAC key for session cookies; rotating it signs everyone out. */
  cookieSecret: string;
  /** Folders the web page may browse and start sessions in. */
  roots: string[];
  /** Hide Claude sessions whose cwd contains one of these substrings. */
  claudeHiddenCwds: string[];
  codexBin?: string;
  claudeBin?: string;
  piDesktopDataDir?: string;
  piBin?: string;
  piAgentDir?: string;
};

export const DATA_DIR = process.env.ANYWHERE_HOME ?? join(homedir(), ".anywherecoding");
const CONFIG_PATH = join(DATA_DIR, "config.json");

function secret(): string {
  return randomBytes(24).toString("base64url");
}

/** Load config, creating it with fresh secrets on first run. Env overrides host/port. */
export function loadConfig(): Config {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  let stored: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const config: Config = {
    host: "0.0.0.0",
    port: 8787,
    roots: [homedir()],
    // Gateway sessions that magpie runs on its own behalf, not user chats.
    claudeHiddenCwds: ["magpie-claude-work"],
    ...stored,
    token: stored.token || secret(),
    cookieSecret: stored.cookieSecret || secret(),
  };
  if (JSON.stringify(stored) !== JSON.stringify(config)) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(CONFIG_PATH, 0o600);
  }
  if (process.env.ANYWHERE_HOST) config.host = process.env.ANYWHERE_HOST;
  if (process.env.ANYWHERE_PORT) config.port = Number(process.env.ANYWHERE_PORT);
  return config;
}

export const CONFIG_FILE = CONFIG_PATH;
