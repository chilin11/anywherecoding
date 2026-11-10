import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Connections } from "./connections.ts";
import { Hub, type Adapter } from "./hub.ts";

test("retired connections are ignored without altering the file; other unknown entries fail", () => {
  const directory = mkdtempSync(join(tmpdir(), "anywhere-connections-"));
  const file = join(directory, "connections.json");
  try {
    const original = JSON.stringify({ enabled: ["pi", "botsteam"] });
    writeFileSync(file, original);
    const created: string[] = [];
    const connections = new Connections(file, new Hub(), (agent) => {
      created.push(agent);
      return { agent } as Adapter;
    });
    assert.deepEqual(created, ["pi"]);
    assert.deepEqual([...connections.adapters.keys()], ["pi"]);
    assert.equal(readFileSync(file, "utf8"), original);
    writeFileSync(file, JSON.stringify({ enabled: ["other"] }));
    assert.throws(() => new Connections(file, new Hub(), () => { throw new Error("unexpected factory"); }), /连接配置无效/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
