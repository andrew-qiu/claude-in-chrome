// chrome-bridge 统一帧协议：uint32LE 长度前缀 + UTF-8 JSON（与 Chrome Native Messaging 同构）
// 三条链路（扩展↔host、host↔server）共用。

export const MAX_FRAME = 1048576; // 1MB，同官方限制

export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  if (body.length > MAX_FRAME) {
    throw new Error(`frame too large: ${body.length} > ${MAX_FRAME}`);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// 流式解码器：feed(chunk) 依次吐出完整帧（对象）；坏帧/超限抛错，由调用方断连。
export class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32LE(0);
      if (len === 0 || len > MAX_FRAME) {
        throw new Error(`invalid frame length: ${len}`);
      }
      if (this.buffer.length < 4 + len) break;
      const body = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      frames.push(JSON.parse(body.toString("utf-8")));
    }
    return frames;
  }
}

// 消息构造器
export const msg = {
  hello: (info) => ({ type: "hello", ...info }),
  ping: () => ({ type: "ping", ts: Date.now() }),
  pong: (ts) => ({ type: "pong", ts, now: Date.now() }),
  toolRequest: (id, tool, args) => ({ type: "tool_request", id, tool, args: args ?? {} }),
  toolResponse: (id, ok, payload) => ({ type: "tool_response", id, ok, ...payload }),
  notification: (event, data) => ({ type: "notification", event, data }),
  evict: (info) => ({ type: "evict", ...info }), // 新会话接管：要求持有者释放 TCP 桥并休眠
  error: (error) => ({ type: "error", error }),
};
