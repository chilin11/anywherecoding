import { useState, type FormEvent } from "react";
import { api } from "../api.ts";

export function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      onDone();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div className="space-y-2 text-center">
          <img src="/icon.svg" alt="" className="mx-auto size-12" />
          <h1 className="text-xl font-semibold">AnywhereCoding</h1>
          <p className="text-sm text-zinc-500">输入访问令牌（见 ~/.anywherecoding/config.json）</p>
        </div>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="访问令牌"
          className="w-full rounded-xl border border-zinc-300 bg-transparent px-4 py-3 outline-none focus:border-zinc-500 dark:border-zinc-700"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          disabled={busy || !token.trim()}
          className="w-full rounded-xl bg-zinc-900 py-3 font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
