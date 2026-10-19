import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "aw_session";
const MAX_AGE_S = 30 * 24 * 3600;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      try { out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
      catch { /* Ignore malformed cookies. */ }
    }
  }
  return out;
}

/** Behind cloudflared the page is https even though this socket is plain http. */
function isHttps(request: IncomingMessage): boolean {
  return request.headers["x-forwarded-proto"] === "https" || request.headers["cf-visitor"]?.includes("https") === true;
}

export class Auth {
  private readonly token: string;
  private readonly secret: string;
  /** remote address -> recent failed login timestamps */
  private readonly failures = new Map<string, number[]>();

  constructor(token: string, secret: string) {
    this.token = token;
    this.secret = secret;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private issue(): string {
    const payload = `${Date.now() + MAX_AGE_S * 1000}.${randomBytes(9).toString("base64url")}`;
    return `${payload}.${this.sign(payload)}`;
  }

  isAuthenticated(request: IncomingMessage): boolean {
    const bearer = request.headers.authorization;
    if (bearer?.startsWith("Bearer ") && safeEqual(bearer.slice(7).trim(), this.token)) return true;
    const value = parseCookies(request.headers.cookie)[COOKIE];
    if (!value) return false;
    const cut = value.lastIndexOf(".");
    if (cut < 0) return false;
    const payload = value.slice(0, cut);
    if (!safeEqual(value.slice(cut + 1), this.sign(payload))) return false;
    return Number(payload.split(".")[0]) > Date.now();
  }

  private clientKey(request: IncomingMessage): string {
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
    const forwarded = local ? request.headers["cf-connecting-ip"] ?? request.headers["x-forwarded-for"] : undefined;
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    return first?.trim() || request.socket.remoteAddress || "?";
  }

  /** Returns false (and records a failure) when the token is wrong or the client is throttled. */
  login(request: IncomingMessage, response: ServerResponse, token: string): "ok" | "bad" | "throttled" {
    const key = this.clientKey(request);
    const now = Date.now();
    for (const [ip, times] of this.failures) if (!times.some((at) => now - at < 15 * 60_000)) this.failures.delete(ip);
    const recent = (this.failures.get(key) ?? []).filter((at) => now - at < 15 * 60_000);
    if (recent.length >= 10) return "throttled";
    if (!safeEqual(token, this.token)) {
      recent.push(now);
      this.failures.set(key, recent);
      return "bad";
    }
    this.failures.delete(key);
    const secure = isHttps(request) ? "; Secure" : "";
    response.setHeader(
      "Set-Cookie",
      `${COOKIE}=${encodeURIComponent(this.issue())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}${secure}`,
    );
    return "ok";
  }

  logout(response: ServerResponse): void {
    response.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  /**
   * CSRF guard for state-changing requests: a browser always sends Origin on
   * cross-site POSTs, so it must match the Host the page was served from.
   */
  sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }
}
