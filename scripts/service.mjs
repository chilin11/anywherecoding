#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, DATA_DIR, loadConfig } from "../server/config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "io.github.chilin11.anywherecoding";
const domain = `gui/${process.getuid()}`;
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const command = process.argv[2] ?? "status";
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/**
 * A node path that survives upgrades: Homebrew's process.execPath is the versioned Cellar binary,
 * which disappears after `brew upgrade node`. Prefer a PATH symlink that resolves to the same binary.
 */
function stableNode() {
  const current = realpathSync(process.execPath);
  const candidates = [...(process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "node")), "/opt/homebrew/bin/node", "/usr/local/bin/node"];
  for (const candidate of candidates) {
    try { if (candidate !== current && realpathSync(candidate) === current) return candidate; } catch { /* missing */ }
  }
  return process.execPath;
}
function launch(...args) { return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
/** bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error". */
function bootoutAndWait(target) {
  try { launch("bootout", target); } catch { /* not loaded */ }
  for (let i = 0; i < 50; i++) {
    try { launch("print", target); } catch { return; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}
function bootstrap(plistPath) {
  for (let attempt = 1; ; attempt++) {
    try { launch("bootstrap", domain, plistPath); return; } catch (error) {
      if (attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
    }
  }
}
function installed() { try { launch("print", `${domain}/${label}`); return true; } catch { return false; } }

if (command === "token") {
  console.log(loadConfig().token);
} else if (command === "url") {
  const { host, port } = loadConfig();
  console.log(`http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}/`);
} else if (command === "install") {
  if (process.platform !== "darwin") throw new Error("LaunchAgent installation requires macOS");
  if (!existsSync(join(root, "web/dist/index.html"))) throw new Error("Run pnpm build first");
  loadConfig();
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(join(DATA_DIR, "logs"), { recursive: true, mode: 0o700 });
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(stableNode())}</string><string>${xml(join(root, "server/main.ts"))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>ANYWHERE_HOME</key><string>${xml(DATA_DIR)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(DATA_DIR, "logs/server.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(DATA_DIR, "logs/error.log"))}</string>
</dict></plist>\n`;
  if (existsSync(plist) && !readFileSync(plist, "utf8").includes(`<string>${label}</string>`)) throw new Error("Existing unrelated plist; refusing overwrite");
  bootoutAndWait(`${domain}/${label}`);
  writeFileSync(plist, content, { mode: 0o600 });
  execFileSync("plutil", ["-lint", plist], { stdio: "inherit" });
  bootstrap(plist);
  console.log(`Installed ${label} (${stableNode()}). Config: ${CONFIG_FILE}`);
} else if (command === "restart") {
  launch("kickstart", "-k", `${domain}/${label}`);
  console.log("Restart requested");
} else if (command === "uninstall") {
  bootoutAndWait(`${domain}/${label}`);
  // Leave plist disabled on disk so no unrelated file is deleted.
  if (existsSync(plist)) {
    const { renameSync } = await import("node:fs");
    renameSync(plist, `${plist}.disabled`);
  }
  console.log("Service stopped and disabled; config and conversations preserved");
} else if (command === "status") {
  if (!installed()) { console.log("Service is not loaded"); process.exitCode = 1; }
  else console.log(launch("print", `${domain}/${label}`).split("\n").filter((line) => /state =|pid =|last exit code =/.test(line)).join("\n"));
} else {
  throw new Error("Usage: node scripts/service.mjs install|status|restart|uninstall|token|url");
}
