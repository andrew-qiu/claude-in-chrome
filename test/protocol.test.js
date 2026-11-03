import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder, msg, MAX_FRAME } from "../lib/protocol.js";

test("encodeFrame 产出 4 字节 LE 前缀 + JSON body", () => {
  const buf = encodeFrame({ type: "ping", ts: 42 });
  assert.equal(buf.readUInt32LE(0), buf.length - 4);
  assert.deepEqual(JSON.parse(buf.subarray(4).toString("utf-8")), { type: "ping", ts: 42 });
});

test("FrameDecoder 处理分片到达", () => {
  const d = new FrameDecoder();
  const a = encodeFrame({ hello: 1 });
  const b = encodeFrame({ hello: 2 });
  const stream = Buffer.concat([a, b]);
  // 逐字节喂入，极端分片
  const got = [];
  for (const byte of stream) got.push(...d.feed(Buffer.from([byte])));
  assert.deepEqual(got, [{ hello: 1 }, { hello: 2 }]);
});

test("FrameDecoder 半帧等待", () => {
  const d = new FrameDecoder();
  const f = encodeFrame({ a: "x".repeat(100) });
  assert.equal(d.feed(f.subarray(0, 30)).length, 0); // 不完整 → 无输出
  assert.deepEqual(d.feed(f.subarray(30)), [{ a: "x".repeat(100) }]);
});

test("超限帧抛错（调用方应断连）", () => {
  const d = new FrameDecoder();
  const head = Buffer.alloc(4);
  head.writeUInt32LE(MAX_FRAME + 1, 0);
  assert.throws(() => d.feed(head));
});

test("零长度帧抛错", () => {
  const d = new FrameDecoder();
  assert.throws(() => d.feed(Buffer.alloc(4)));
});

test("encodeFrame 拒绝超限 body", () => {
  assert.throws(() => encodeFrame({ big: "x".repeat(MAX_FRAME) }));
});

test("msg 构造器形状", () => {
  assert.deepEqual(msg.toolRequest(7, "navigate", { url: "https://a" }), {
    type: "tool_request",
    id: 7,
    tool: "navigate",
    args: { url: "https://a" },
  });
  assert.deepEqual(msg.toolResponse(7, false, { error: "boom" }), {
    type: "tool_response",
    id: 7,
    ok: false,
    error: "boom",
  });
});
