import type { ImageInfo } from "./types.ts";

export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export function textLineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i;
const SAFE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

/** Native image content and explicit image file/URL fields, bounded without scanning arbitrary prose. */
export function extractImages(value: unknown): ImageInfo[] {
  const images: ImageInfo[] = [];
  const seen = new Set<string>();
  const add = (src: unknown, alt?: string) => {
    if (typeof src !== "string" || !src || src.length > 28_000_000 || seen.has(src)) return;
    if (!SAFE_IMAGE.test(src) && !IMAGE_PATH.test(src)) return;
    seen.add(src);
    images.push({ src, ...(alt ? { alt } : {}) });
  };
  let visited = 0;
  function walk(current: unknown, depth: number, imageField = false): void {
    if (++visited > 3000 || depth > 9 || images.length >= 12 || current == null) return;
    if (typeof current === "string") { if (imageField || IMAGE_PATH.test(current)) add(current); return; }
    if (Array.isArray(current)) { for (const entry of current) walk(entry, depth + 1, imageField); return; }
    if (typeof current !== "object") return;
    const item = current as Record<string, any>;
    if (item.source?.type === "base64" && typeof item.source.data === "string") add(`data:${item.source.media_type ?? "image/png"};base64,${item.source.data}`);
    if (item.type === "image" && typeof item.data === "string") add(`data:${item.mimeType ?? item.mime_type ?? "image/png"};base64,${item.data}`);
    if (typeof item.b64_json === "string") add(`data:image/png;base64,${item.b64_json}`);
    if (item.type === "image" || item.type === "image_url" || item.type === "localImage") {
      add(item.url ?? item.image_url?.url ?? item.imageUrl ?? item.source?.url ?? item.path);
    }
    for (const [key, entry] of Object.entries(item)) {
      if (["data", "b64_json", "source", "old_string", "new_string", "thinking", "messageJson"].includes(key)) continue;
      const field = /^(?:image|images|imageUrl|image_url|url|path|file_path|filePath|savedPath|saved_path|outputPath|output_path|result|results|content|artifacts|files|output)$/i.test(key);
      if (field || typeof entry === "object") walk(entry, depth + 1, field);
    }
  }
  walk(value, 0);
  return images;
}
