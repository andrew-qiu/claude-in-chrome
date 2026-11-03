// claude-in-chrome Windows Native Messaging Host
// 职责：纯帧中继 —— Chrome native messaging (stdin/stdout, 4B LE 长度前缀 + JSON)
//       ↔ TCP (默认 localhost:8765 → WSL2 的 MCP server, 经 WSL localhostForwarding)
//
// 参数: --bridge-host <host>  默认 localhost
//       --bridge-port <port>  默认 8765
//       --selftest           不挂 stdin，向 bridge 发 hello+ping 后退出（安装验证用）
//
// 日志: 同目录 host.log（stderr 也会写，Chrome 会丢弃 stderr）

import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import net from "node:net";

const MAX_FRAME = 1048576;
const VERSION = "0.3.0";
const PING_INTERVAL = 30000;

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { host: string; port: number; selftest: boolean } = {
    host: "localhost",
    port: 8765,
    selftest: false,
  };
  let hostGiven = false, portGiven = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bridge-host") { out.host = args[++i]; hostGiven = true; }
    else if (args[i] === "--bridge-port") { out.port = Number(args[++i]); portGiven = true; }
    else if (args[i] === "--selftest") out.selftest = true;
  }
  // 环境变量仅补充未显式给定的参数（否则用户级 setx 的 CLAUDE_IN_CHROME_ADDR
  // 会覆盖 CLI 传参——selftest 指定端口时会连到错误地址）。manifest "path"
  // 只能是 exe 路径，所以运行态地址仍经环境变量由 install.sh 写入系统。
  // 旧名 CHROME_BRIDGE_ADDR 回退支持：存量 Windows 部署 setx 的还是旧名。
  const addrEnv = process.env.CLAUDE_IN_CHROME_ADDR ?? process.env.CHROME_BRIDGE_ADDR;
  if (addrEnv) {
    const [h, p] = addrEnv.split(":");
    if (h && !hostGiven) out.host = h;
    if (p && !portGiven) out.port = Number(p);
  }
  return out;
}

const cfg = parseArgs();

const LOG_PATH = join(dirname(process.execPath), "host.log");
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [claude-in-chrome host] ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {}
  console.error(line.trimEnd());
}

// ---------------------------------------------------------------------------
// Native messaging 帧 IO（stdin/stdout）
// ---------------------------------------------------------------------------
function writeStdoutFrame(obj: unknown) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

function decodeFrames(buffer: Buffer): { frames: object[]; rest: Buffer } {
  // 解析缓冲区里所有完整帧，返回剩余字节
  const frames: object[] = [];
  let buf = buffer;
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len === 0 || len > MAX_FRAME) throw new Error(`invalid frame length ${len}`);
    if (buf.length < 4 + len) break;
    frames.push(JSON.parse(buf.subarray(4, 4 + len).toString("utf-8")));
    buf = buf.subarray(4 + len);
  }
  return { frames, rest: buf };
}

// ---------------------------------------------------------------------------
// TCP 连接（指数退避重连）
// ---------------------------------------------------------------------------
let tcp: net.Socket | null = null;
let tcpConnected = false;
let stdinRest = Buffer.alloc(0);
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pongsMissed = 0;

function connectTcp(onFrame: (f: object) => void, onUp: () => void) {
  let attempt = 0;
  const tryConnect = () => {
    if (tcpConnected) return;
    // localhost 桥：服务端随 Claude Code 会话重启，退避封顶 3s，
    // 让 /chrome 的 0/2/4s 重试窗口（受钩子 10s 预算约束）能盖住重连
    const wait = Math.min(1000 * 2 ** attempt, 3000);
    setTimeout(() => {
      const sock = net.connect(cfg.port, cfg.host, () => {
        attempt = 0;
        tcp = sock;
        tcpConnected = true;
        pongsMissed = 0;
        log(`connected to bridge ${cfg.host}:${cfg.port}`);
        sock.write(encodeTcpFrame({ type: "hello", client: "host", version: VERSION, pid: process.pid }));
        onUp();
        pingTimer = setInterval(() => {
          if (!tcpConnected) return;
          writeTcpFrame({ type: "ping", ts: Date.now() });
          if (++pongsMissed >= 3) {
            log("3 pings unanswered; reconnecting");
            sock.destroy();
          }
        }, PING_INTERVAL);
      });
      sock.on("data", (chunk) => {
        try {
          for (const f of parseTcpBuffer(chunk)) onFrame(f);
        } catch (e) {
          log(`bad frame from bridge: ${(e as Error).message}`);
          sock.destroy();
        }
      });
      sock.on("error", (e) => log(`tcp error: ${e.message}`));
      sock.on("close", () => {
        tcpConnected = false;
        if (pingTimer) clearInterval(pingTimer);
        if (!process.exitCode) tryConnect();
      });
    }, attempt++ === 0 ? 0 : wait);
  };
  tryConnect();
}

let tcpBuf = Buffer.alloc(0);
function parseTcpBuffer(chunk: Buffer): object[] {
  tcpBuf = Buffer.concat([tcpBuf, chunk]);
  const out: object[] = [];
  while (tcpBuf.length >= 4) {
    const len = tcpBuf.readUInt32LE(0);
    if (len === 0 || len > MAX_FRAME) throw new Error(`invalid frame length ${len}`);
    if (tcpBuf.length < 4 + len) break;
    out.push(JSON.parse(tcpBuf.subarray(4, 4 + len).toString("utf-8")));
    tcpBuf = tcpBuf.subarray(4 + len);
  }
  return out;
}

function encodeTcpFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}
function writeTcpFrame(obj: unknown) {
  if (tcp?.writable) tcp.write(encodeTcpFrame(obj));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
if (cfg.selftest) {
  log(`selftest: connecting ${cfg.host}:${cfg.port}`);
  connectTcp(
    (f) => {
      const m = f as { type?: string };
      log(`selftest frame: ${JSON.stringify(m).slice(0, 200)}`);
      if (m.type === "hello" || m.type === "pong") {
        log("selftest OK");
        process.exit(0);
      }
    },
    () => writeTcpFrame({ type: "ping", ts: Date.now() })
  );
  setTimeout(() => {
    log("selftest: no response within 10s");
    process.exit(1);
  }, 10000);
} else {
  // 正常模式：stdin 帧 → TCP，TCP 帧 → stdout（同构帧，纯中继）
  let stdinClosed = false;
  process.stdin.on("data", (chunk: Buffer) => {
    stdinRest = Buffer.concat([stdinRest, chunk]);
    try {
      const { frames, rest } = decodeFrames(stdinRest);
      stdinRest = rest;
      for (const f of frames) {
        const m = f as { type?: string; ts?: number };
        if (m.type === "ping") {
          writeStdoutFrame({ type: "pong", ts: m.ts, now: Date.now() });
        } else {
          log(`ext→bridge: ${m.type}`);
          writeTcpFrame(f);
        }
      }
    } catch (e) {
      log(`bad frame from extension: ${(e as Error).message}`);
      process.exit(1);
    }
  });
  process.stdin.on("end", () => {
    stdinClosed = true;
    log("stdin closed (extension went away); exiting");
    process.exit(0);
  });
  process.stdin.on("error", () => process.exit(1));

  connectTcp(
    (f) => {
      const m = f as { type?: string; ts?: number };
      if (m.type === "ping") {
        writeTcpFrame({ type: "pong", ts: m.ts, now: Date.now() });
        return;
      }
      if (m.type === "pong") {
        pongsMissed = 0;
        return;
      }
      log(`bridge→ext: ${m.type}`);
      writeStdoutFrame(f);
    },
    () => {}
  );

  // 空转防护：extension 断开且 TCP 也断开时进程由 stdin end / Chrome 杀掉
  void stdinClosed;
  // Bun 下 stdin 需要显式 resume 读取
  (process.stdin as any).resume?.();
}

export {};
