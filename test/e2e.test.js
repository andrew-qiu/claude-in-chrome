// 端到端集成测试：拉起 server/index.js，模拟 host.exe 反向连接，
// 走完整 MCP stdio 协议（initialize → tools/list → browser_status → tools/call）。
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import path from "path";
import { encodeFrame, FrameDecoder } from "../lib/protocol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 19000 + Math.floor(Math.random() * 500);

test("MCP stdio ↔ TCP ↔ host 全链路", async (t) => {
  const server = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    env: { ...process.env, CLAUDE_IN_CHROME_PORT: String(PORT) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  server.stderr.on("data", () => {}); // 不冲刷测试输出

  let rpcId = 0;
  const pendingRpc = new Map();
  let outBuf = "";
  server.stdout.on("data", (chunk) => {
    outBuf += chunk;
    let nl;
    while ((nl = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (!line) continue;
      const resp = JSON.parse(line);
      const p = pendingRpc.get(resp.id);
      if (p) { pendingRpc.delete(resp.id); p(resp); }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++rpcId;
      pendingRpc.set(id, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await sleep(700);
  const init = await rpc("initialize", {});
  assert.equal(init.result.serverInfo.name, "claude-in-chrome");

  const tools = await rpc("tools/list", {});
  assert.equal(tools.result.tools.length, 22);

  const before = await rpc("tools/call", { name: "browser_status", arguments: {} });
  assert.match(before.result.content[0].text, /^not connected/);

  // 模拟 host.exe：server 已就绪后再连接，tool_request 应答假数据
  const toolAnswers = {
    status: { connected: true, extensionId: "fake-ext-for-e2e" },
    tabs_list: [{ tabId: 1, title: "Fake Tab", url: "https://example.com/", active: true }],
  };
  const fakeHost = net.connect(PORT, "127.0.0.1");
  t.after(() => fakeHost.destroy());
  const dec = new FrameDecoder();
  fakeHost.on("data", (chunk) => {
    for (const f of dec.feed(chunk)) {
      if (f.type === "tool_request") {
        const answer = toolAnswers[f.tool];
        fakeHost.write(encodeFrame({ type: "tool_response", id: f.id, ok: !!answer, ...(answer ? { result: answer } : { error: `no fake answer for ${f.tool}` }) }));
      } else if (f.type === "ping") {
        fakeHost.write(encodeFrame({ type: "pong", ts: f.ts }));
      }
    }
  });
  fakeHost.write(encodeFrame({ type: "hello", client: "host", version: "0.3.0-e2e" }));
  await sleep(400);
  const status = await rpc("tools/call", { name: "browser_status", arguments: {} });
  assert.match(status.result.content[0].text, /connected: /);

  const tabs = await rpc("tools/call", { name: "browser_tabs_list", arguments: {} });
  assert.match(tabs.result.content[0].text, /Fake Tab/);

  const bad = await rpc("tools/call", { name: "browser_no_such", arguments: {} });
  assert.ok(bad.error || bad.result?.isError, "未知工具应报错");

  fakeHost.destroy();
  await sleep(400);
  const after = await rpc("tools/call", { name: "browser_status", arguments: {} });
  assert.match(after.result.content[0].text, /^not connected/);
});
