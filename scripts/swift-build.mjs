// Shared Swift build for the menu bar app (scripts/menubar.mjs) and AnywhereCoding.app (scripts/macapp.mjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sourceDir = join(root, "macos/AnywhereCodingBar");
export const minimumMacOS = "13.0";

export function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
}

export const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Universal by default so one app runs on Apple silicon and Intel; `native` builds only this Mac's arch. */
export function compileApp(output, { native = false } = {}) {
  if (process.platform !== "darwin") throw new Error("Building the macOS app requires macOS");
  const sources = readdirSync(sourceDir).filter((file) => file.endsWith(".swift")).sort().map((file) => join(sourceDir, file));
  const arches = native ? [process.arch === "arm64" ? "arm64" : "x86_64"] : ["arm64", "x86_64"];
  mkdirSync(dirname(output), { recursive: true });
  const slices = arches.map((arch) => {
    const slice = `${output}-${arch}`;
    run("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macos${minimumMacOS}`, "-o", slice, ...sources], { stdio: ["ignore", "inherit", "inherit"] });
    return slice;
  });
  run("lipo", ["-create", "-output", output, ...slices]);
  for (const slice of slices) rmSync(slice, { force: true });
}

export function infoPlist({ bundleId, name, executable, version, extra = "" }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${xml(bundleId)}</string>
<key>CFBundleName</key><string>${xml(name)}</string>
<key>CFBundleDisplayName</key><string>${xml(name)}</string>
<key>CFBundleExecutable</key><string>${xml(executable)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(version)}</string>
<key>CFBundleVersion</key><string>${xml(version)}</string>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
${extra}</dict></plist>
`;
}
