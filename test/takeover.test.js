// 多会话接管（last-session-wins）集成测试：
// 会话 A 持有端口且 host 已连 → 会话 B 启动（争同一端口）→ A 收 evict 转休眠
// （进程/stdio 保活，browser_status 报被接管）→ host 重连到 B → B 报 connected。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import path from "path";
import { encodeFrame, FrameDecoder } from "../lib/protocol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PORT = 18000 + Math.floor(Math.random() * 2000);
let portSeq = 0; // 每个用例独占端口，避免用例间互相逐出
const procs = [];

function startServer(port) {
  const p = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    env: { ...process.env, CLAUDE_IN_CHROME_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(p);
  const stderr = [];
  p.stderr.on("data", (c) => stderr.push(c.toString()));
  const stdout = [];
  p.stdout.on("data", (c) => stdout.push(c.toString()));
  const waitLog = (pat, ms = 5000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (stderr.join("").includes(pat)) return (clearInterval(poll), res());
        if (Date.now() - t0 > ms || p.exitCode !== null)
          return (clearInterval(poll), rej(new Error(`timeout waiting "${pat}"`)));
      }, 30);
    });
  // 经 stdio 调 browser_status，返回文本
  const status = () =>
    new Promise((res, rej) => {
      const id = Date.now();
      const onChunk = () => {
        const lines = stdout.join("").split("\n");
        for (const l of lines) {
          try {
            const r = JSON.parse(l);
            if (r.id === id) {
              p.stdout.off("data", onChunk);
              stdout.length = 0;
              return res(r.result.content[0].text);
            }
          } catch {}
        }
      };
      p.stdout.on("data", onChunk);
      p.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_status", arguments: {} } }) + "\n"
      );
      setTimeout(() => rej(new Error("browser_status timeout")), 5000);
    });
  return { p, waitLog, status };
}

// 模拟 host.exe：连接、发 hello
function connectHost(port) {
  return new Promise((res, rej) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(encodeFrame({ type: "hello", client: "host", version: "test", pid: 1 }));
      res(sock);
    });
    sock.on("error", rej);
  });
}

const closed = (sock) => new Promise((res) => (sock.destroyed ? res() : sock.on("close", res)));

after(() => {
  for (const p of procs) p.kill();
});

test("新会话逐出旧会话：旧会话休眠保活，host 重连到新会话", async () => {
  const port = BASE_PORT + portSeq++;
  const a = startServer(port);
  await a.waitLog("TCP bridge listening");

  const host1 = await connectHost(port);
  await a.waitLog("host connected");
  assert.match(await a.status(), /connected: /);

  const b = startServer(port); // 与 A 争同一端口 → 触发逐出
  await b.waitLog("TCP bridge listening");
  await a.waitLog("evicted by newer session");

  // host 侧旧连接被持有者关闭（真实 host.exe 会以 ≤3s 退避重连到新持有者）
  await closed(host1);
  const host2 = await connectHost(port);
  await b.waitLog("host connected");
  assert.match(await b.status(), /connected: /);

  // 旧会话：进程保活 + 状态可读 + 工具报被接管
  assert.equal(a.p.exitCode, null, "被逐出的会话不应退出（MCP 保活）");
  assert.match(await a.status(), /taken over by a newer Claude Code session/);
  host2.destroy();
});

test("evict 控制连接不会被持有者误当 host", async () => {
  const port = BASE_PORT + portSeq++;
  const a = startServer(port);
  await a.waitLog("TCP bridge listening");
  const host = await connectHost(port);
  await a.waitLog("host connected");

  // 只发 evict 的控制连接：持有者应休眠放端口，且 evict 帧记录来源 pid
  const ctrl = net.connect(port, "127.0.0.1");
  ctrl.on("connect", () => ctrl.end(encodeFrame({ type: "evict", pid: 4242 })));
  await a.waitLog("evicted by newer session");
  // 真 host 连接被 handleEvict 主动断开（dropHost），而非被控制连接顶替
  await closed(host);
  await closed(ctrl);
  assert.match(await a.status(), /pid 4242/);
});

test("普通 TCP 连接首帧非 hello/evict 被丢弃且不影响 host", async () => {
  const port = BASE_PORT + portSeq++;
  const a = startServer(port);
  await a.waitLog("TCP bridge listening");
  const host = await connectHost(port);
  await a.waitLog("host connected");

  const junk = net.connect(port, "127.0.0.1");
  junk.on("connect", () => junk.end(encodeFrame({ type: "tool_response", id: 99, ok: true })));
  await closed(junk);
  await new Promise((res) => setTimeout(res, 300));
  // 真 host 仍是当前连接
  assert.match(await a.status(), /connected: /);
  host.destroy();
});
