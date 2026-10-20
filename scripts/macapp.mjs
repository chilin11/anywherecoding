#!/usr/bin/env node
// Build AnywhereCoding.app (menu bar app + bundled Node runtime + server + web UI) and wrap it in a DMG.
// Usage: pnpm dmg            (universal: Apple silicon + Intel)
//        pnpm dmg --native   (this Mac's architecture only; faster local test build)
//        node scripts/macapp.mjs --app-only   (skip the DMG)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { compileApp, infoPlist, root, run } from "./swift-build.mjs";

const NODE_VERSION = "24.22.0";
// From https://nodejs.org/dist/v24.22.0/SHASUMS256.txt
const NODE_SHA256 = {
  arm64: "75ddfb875bbd868ebe57536f4442225f54dd10f6d2178dd439de869a5c648dc3",
  x64: "b890d687983ddc811641f6739c3ce99d2912c58f9e44b68aa25944037b425305",
};
const name = "AnywhereCoding";
const bundleId = "io.github.chilin11.anywherecoding.app";
const dmgName = `${name}-macOS.dmg`;
const native = process.argv.includes("--native");
const appOnly = process.argv.includes("--app-only");
const releaseDir = join(root, "release");
const workDir = join(releaseDir, "mac");
const app = join(workDir, `${name}.app`);
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
const cacheDir = process.env.ANYWHERE_NODE_CACHE ?? join(homedir(), "Library/Caches/anywherecoding/node");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function step(message) { console.log(`\n▸ ${message}`); }
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function nodeTarball(arch) {
  const file = `node-v${NODE_VERSION}-darwin-${arch}.tar.xz`;
  const path = join(cacheDir, file);
  if (!existsSync(path) || sha256(path) !== NODE_SHA256[arch]) {
    mkdirSync(cacheDir, { recursive: true });
    console.log(`  downloading ${file}`);
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${file}`);
    if (!response.ok) throw new Error(`Download ${file} failed: HTTP ${response.status}`);
    writeFileSync(`${path}.part`, Buffer.from(await response.arrayBuffer()));
    rmSync(path, { force: true });
    cpSync(`${path}.part`, path);
    rmSync(`${path}.part`, { force: true });
  }
  const actual = sha256(path);
  if (actual !== NODE_SHA256[arch]) throw new Error(`${file}: SHA256 ${actual} does not match the pinned value`);
  return path;
}

/** Official Node binaries, one per arch, merged into one universal executable. */
async function bundleNode() {
  const arches = native ? [process.arch === "arm64" ? "arm64" : "x64"] : ["arm64", "x64"];
  const scratch = mkdtempSync(join(tmpdir(), "aw-node-"));
  try {
    const binaries = [];
    for (const arch of arches) {
      const tarball = await nodeTarball(arch);
      const out = join(scratch, arch);
      mkdirSync(out);
      const prefix = `node-v${NODE_VERSION}-darwin-${arch}`;
      run("tar", ["-xJf", tarball, "-C", out, `${prefix}/bin/node`, `${prefix}/LICENSE`]);
      binaries.push(join(out, prefix, "bin/node"));
      if (binaries.length === 1) cpSync(join(out, prefix, "LICENSE"), join(resources, "node/LICENSE"));
    }
    mkdirSync(join(resources, "node/bin"), { recursive: true });
    run("lipo", ["-create", "-output", join(resources, "node/bin/node"), ...binaries]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function bundleServer() {
  cpSync(join(root, "server"), join(resources, "server"), { recursive: true, filter: (source) => !source.endsWith(".test.ts") });
  cpSync(join(root, "web/dist"), join(resources, "web/dist"), { recursive: true });
  // `type: module` makes Node treat the .ts sources as ES modules; `version` is shown in the UI.
  const manifest = { name: pkg.name, version: pkg.version, private: true, type: "module", description: pkg.description, homepage: pkg.homepage };
  writeFileSync(join(resources, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function bundleIcon() {
  const scratch = mkdtempSync(join(tmpdir(), "aw-icon-"));
  try {
    const tool = join(scratch, "icon");
    run("xcrun", ["swiftc", "-O", "-o", tool, join(root, "macos/icon.swift")], { stdio: ["ignore", "inherit", "inherit"] });
    run(tool, [join(scratch, "AppIcon.iconset")]);
    run("iconutil", ["-c", "icns", join(scratch, "AppIcon.iconset"), "-o", join(resources, "AppIcon.icns")]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Start the bundled server on a spare port with a throwaway data folder and wait for its marker header. */
async function smokeTest() {
  const home = mkdtempSync(join(tmpdir(), "aw-smoke-"));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(join(resources, "node/bin/node"), [join(resources, "server/main.ts")], {
    cwd: resources,
    env: { ...process.env, ANYWHERE_HOME: home, ANYWHERE_HOST: "127.0.0.1", ANYWHERE_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (child.exitCode !== null) throw new Error(`Bundled server exited (${child.exitCode}): ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        const page = await response.text();
        if (response.headers.get("x-anywherecoding") !== pkg.version) throw new Error("Missing X-AnywhereCoding header");
        if (!page.includes("<div id=\"root\">")) throw new Error("Web UI not served");
        console.log(`  bundled server answered on port ${port} (v${pkg.version})`);
        return;
      } catch (error) {
        if (error instanceof TypeError) continue; // not listening yet
        throw error;
      }
    }
    throw new Error(`Bundled server did not start: ${stderr}`);
  } finally {
    child.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  }
}

function buildDmg() {
  const stage = join(workDir, "dmg");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run("ditto", [app, join(stage, `${name}.app`)]);
  symlinkSync("/Applications", join(stage, "Applications"));
  writeFileSync(join(stage, "安装说明.txt"), `AnywhereCoding ${pkg.version}

1. 把 AnywhereCoding 拖到右边的“应用程序”文件夹。
2. 打开“应用程序”里的 AnywhereCoding。

首次打开如果提示“无法验证开发者”或“Apple 无法检查其是否包含恶意软件”：
  打开“系统设置 › 隐私与安全性”，在页面下方找到 AnywhereCoding，点“仍要打开”，
  再输入密码确认。（本应用没有付费的 Apple 开发者签名，只需允许一次。）

打开后菜单栏会出现 </> 图标，并弹出网页地址和登录令牌。服务随应用运行，
退出菜单栏图标即停止服务；默认开机自动启动，可在菜单里关闭。

数据和配置：~/.anywherecoding（删除应用不会删除它们）
项目主页：${pkg.homepage}
`);
  const dmg = join(releaseDir, dmgName);
  rmSync(dmg, { force: true });
  run("hdiutil", ["create", "-volname", name, "-srcfolder", stage, "-fs", "HFS+", "-format", "ULFO", "-ov", dmg], { stdio: ["ignore", "inherit", "inherit"] });
  run("hdiutil", ["verify", dmg], { stdio: ["ignore", "ignore", "inherit"] });
  writeFileSync(`${dmg}.sha256`, `${sha256(dmg)}  ${dmgName}\n`);
  rmSync(stage, { recursive: true, force: true });
  return dmg;
}

if (process.platform !== "darwin") throw new Error("The macOS app can only be built on macOS");
if (!existsSync(join(root, "web/dist/index.html"))) throw new Error("Missing web/dist; run `pnpm build` first");

step(`Assembling ${name}.app ${pkg.version} (${native ? "native" : "universal"})`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(resources, { recursive: true });
writeFileSync(join(contents, "Info.plist"), infoPlist({
  bundleId, name, executable: name, version: pkg.version,
  extra: `<key>CFBundleIconFile</key><string>AppIcon</string>
<key>NSHumanReadableCopyright</key><string>${pkg.homepage}</string>
`,
}));
run("plutil", ["-lint", join(contents, "Info.plist")]);

step("Compiling the menu bar app");
compileApp(join(contents, "MacOS", name), { native });
step(`Bundling Node ${NODE_VERSION}`);
await bundleNode();
step("Bundling server and web UI");
bundleServer();
step("Drawing the app icon");
bundleIcon();

step("Signing (ad-hoc)");
// lipo invalidates Node's own signature; sign nested code first, then seal the bundle.
run("codesign", ["--force", "--sign", "-", "--timestamp=none", join(resources, "node/bin/node")]);
run("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
for (const binary of [join(contents, "MacOS", name), join(resources, "node/bin/node")]) {
  console.log(`  ${binary.slice(app.length + 1)}: ${run("lipo", ["-archs", binary]).trim()}`);
}

step("Smoke test");
await smokeTest();

if (appOnly) {
  console.log(`\nBuilt ${app}`);
} else {
  step("Creating the disk image");
  const dmg = buildDmg();
  const size = (readFileSync(dmg).length / 1024 / 1024).toFixed(1);
  console.log(`\nBuilt ${dmg} (${size} MB)\n      ${dmg}.sha256`);
}
