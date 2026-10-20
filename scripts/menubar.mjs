#!/usr/bin/env node
// Developer tool: build and install the monitor-only menu bar app (macos/AnywhereCodingBar) next to the
// LaunchAgent service from scripts/service.mjs. End users get AnywhereCoding.app from scripts/macapp.mjs instead.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compileApp, infoPlist, root, run, xml } from "./swift-build.mjs";

const name = "AnywhereCodingBar";
const bundleId = "io.github.chilin11.anywherecoding.menubar";
const label = bundleId;
const domain = `gui/${process.getuid?.() ?? 0}`;
const buildDir = join(root, "macos/build");
const builtApp = join(buildDir, `${name}.app`);
const installDir = join(homedir(), "Applications");
const app = join(installDir, `${name}.app`);
const binary = join(app, "Contents/MacOS", name);
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const command = process.argv[2] ?? "status";

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
function loaded() { try { launch("print", `${domain}/${label}`); return true; } catch { return false; } }

function build() {
  rmSync(builtApp, { recursive: true, force: true });
  compileApp(join(builtApp, "Contents/MacOS", name), { native: process.argv.includes("--native") });
  writeFileSync(join(builtApp, "Contents/Info.plist"), infoPlist({ bundleId, name: "AnywhereCoding", executable: name, version }));
  run("plutil", ["-lint", join(builtApp, "Contents/Info.plist")]);
  // No Developer ID on this machine: ad-hoc sign so the bundle has a stable, valid signature.
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", builtApp]);
  run("codesign", ["--verify", "--strict", builtApp]);
  console.log(`Built ${builtApp}`);
}

function stop() {
  bootoutAndWait(`${domain}/${label}`);
  try { execFileSync("pkill", ["-x", name], { stdio: "ignore" }); } catch { /* not running */ }
}

if (command === "build") {
  build();
} else if (command === "install") {
  build();
  stop();
  mkdirSync(installDir, { recursive: true });
  rmSync(app, { recursive: true, force: true });
  run("ditto", [builtApp, app]);
  // A browser-downloaded package carries quarantine; the user explicitly installs this ad-hoc signed app.
  try { execFileSync("xattr", ["-dr", "com.apple.quarantine", app], { stdio: "ignore" }); } catch { /* not quarantined */ }
  mkdirSync(dirname(plist), { recursive: true });
  if (existsSync(plist) && !readFileSync(plist, "utf8").includes(`<string>${label}</string>`)) throw new Error("Existing unrelated plist; refusing overwrite");
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Interactive</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
`, { mode: 0o644 });
  run("plutil", ["-lint", plist]);
  bootstrap(plist);
  console.log(`Installed ${app} and started it at login (${label})`);
} else if (command === "start") {
  if (!loaded()) bootstrap(plist);
  else launch("kickstart", `${domain}/${label}`);
  console.log("Started");
} else if (command === "uninstall") {
  stop();
  if (existsSync(plist)) renameSync(plist, `${plist}.disabled`);
  rmSync(app, { recursive: true, force: true });
  console.log("Menu bar app removed; server and config untouched");
} else if (command === "status") {
  if (!loaded()) { console.log("Menu bar app is not loaded"); process.exitCode = 1; }
  else console.log(launch("print", `${domain}/${label}`).split("\n").filter((line) => /state =|pid =|last exit code =/.test(line)).join("\n"));
} else {
  throw new Error("Usage: node scripts/menubar.mjs build|install|start|status|uninstall");
}
