#!/usr/bin/env node
// Build, install and manage the macOS menu bar companion (macos/AnywhereCodingBar).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function run(file, args, options = {}) { return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }); }
function launch(...args) { return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function loaded() { try { launch("print", `${domain}/${label}`); return true; } catch { return false; } }

function build() {
  if (process.platform !== "darwin") throw new Error("The menu bar app requires macOS");
  rmSync(builtApp, { recursive: true, force: true });
  const macos = join(builtApp, "Contents/MacOS");
  mkdirSync(macos, { recursive: true });
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  run("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macos13.0`, "-o", join(macos, name), join(root, "macos/AnywhereCodingBar/main.swift")], { stdio: ["ignore", "inherit", "inherit"] });
  writeFileSync(join(builtApp, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>AnywhereCoding</string>
<key>CFBundleDisplayName</key><string>AnywhereCoding</string>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(version)}</string>
<key>CFBundleVersion</key><string>${xml(version)}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
  run("plutil", ["-lint", join(builtApp, "Contents/Info.plist")]);
  // No Developer ID on this machine: ad-hoc sign so the bundle has a stable, valid signature.
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", builtApp]);
  run("codesign", ["--verify", "--strict", builtApp]);
  console.log(`Built ${builtApp}`);
}

function stop() {
  if (loaded()) launch("bootout", `${domain}/${label}`);
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
  launch("bootstrap", domain, plist);
  console.log(`Installed ${app} and started it at login (${label})`);
} else if (command === "start") {
  if (!loaded()) launch("bootstrap", domain, plist);
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
