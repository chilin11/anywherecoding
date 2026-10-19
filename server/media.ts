import { createHmac, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Item } from "./types.ts";

const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif)$/i;
export class Media {
  private secret: string;
  private roots: string[];
  constructor(secret: string, roots: string[]) { this.secret = secret; this.roots = roots; }
  private sign(payload: string): string { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
  private allowed(path: string): string {
    const real = realpathSync(path);
    if (!this.roots.some((root) => { try { const base = realpathSync(root); return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep); } catch { return false; } })) throw Object.assign(new Error("图片不在允许的目录中"), { status: 403 });
    return real;
  }
  source(src: string, cwd?: string | null): string | null {
    if (src.length > 28_000_000) return null;
    if (DATA_IMAGE.test(src)) return src;
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith("/api/media?")) return src;
    try {
      let path = src;
      if (path.startsWith("file://")) path = fileURLToPath(path);
      else if (path.startsWith("sandbox:")) path = path.slice("sandbox:".length);
      try { path = decodeURIComponent(path); } catch { /* Native path may contain percent characters. */ }
      if (!IMAGE_EXT.test(path) || (!isAbsolute(path) && !cwd)) return null;
      path = this.allowed(isAbsolute(path) ? path : resolve(cwd!, path));
      const payload = Buffer.from(path).toString("base64url");
      return `/api/media?p=${payload}&s=${this.sign(payload)}`;
    } catch { return null; }
  }
  item(item: Item, cwd?: string | null): Item {
    const images = item.images?.map((image) => {
      const src = this.source(image.src, cwd);
      return { ...image, src: src ?? "" };
    });
    const text = item.text.replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g, (match, alt, wrapped, raw) => {
      const src = this.source(wrapped ?? raw, cwd);
      return src ? `![${alt}](${src})` : match;
    });
    return { ...item, text, ...(images ? { images } : {}) };
  }
  async read(payload: string, signature: string): Promise<{ bytes: Buffer; mime: string; name: string }> {
    const expected = this.sign(payload);
    if (!payload || payload.length > 16_000 || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw Object.assign(new Error("图片地址无效"), { status: 403 });
    const path = this.allowed(Buffer.from(payload, "base64url").toString("utf8"));
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw Object.assign(new Error("图片过大或不可用"), { status: 400 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bytes = await Promise.race([
      readFile(path, { signal: AbortSignal.timeout(8000) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("图片读取超时，请检查 macOS 文件夹访问权限"), { status: 403 })), 8000); }),
    ]).finally(() => clearTimeout(timer));
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
      : /^GIF8[79]a/.test(bytes.toString("ascii",0,6)) ? "image/gif"
      : bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP" ? "image/webp"
      : bytes.toString("ascii",4,8) === "ftyp" && /avif|avis/.test(bytes.toString("ascii",8,32)) ? "image/avif" : null;
    if (!mime) throw Object.assign(new Error("不是支持的图片文件"), { status: 415 });
    return { bytes, mime, name: path.slice(dirname(path).length + 1) };
  }
}
