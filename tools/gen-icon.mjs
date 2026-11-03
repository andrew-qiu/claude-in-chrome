// claude-in-chrome 扩展图标生成器（零第三方依赖：node 自带 zlib 手写 PNG）
// 设计：深炭底圆角方 + 橙色星芒（Claude 品牌色系 #D97757）+ 中心微光晕
// 用法：node tools/gen-icon.mjs   →  extension/icons/icon{16,32,48,128}.png
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// PNG 编码（RGBA8）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// SDF 工具（坐标 u,v ∈ [-1,1]，y 向下）
// ---------------------------------------------------------------------------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
// d 像素单位时的 1px 抗锯齿覆盖
const cov = (dPx) => clamp(0.5 - dPx, 0, 1);

function sdRoundRect(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  return Math.hypot(px - ax - abx * t, py - ay - aby * t);
}

// 星芒：8 根射线（正方向长、斜方向短）+ 中心圆盘，颜色由中心向外加深
const SPOKES = [];
for (let k = 0; k < 8; k++) {
  const ang = (k * Math.PI) / 4;
  const long = k % 2 === 0;
  SPOKES.push({
    ax: Math.cos(ang) * 0.10, ay: Math.sin(ang) * 0.10,
    bx: Math.cos(ang) * (long ? 0.74 : 0.58), by: Math.sin(ang) * (long ? 0.74 : 0.58),
    r: long ? 0.100 : 0.094,
  });
}
const DISC_R = 0.155;

const BG_TOP = [62, 57, 50];    // 炭棕，顶部略亮
const BG_BOT = [24, 22, 20];    // 近黑
const RIM = [128, 116, 100];    // 边缘高光
const SPARK_IN = [242, 178, 148]; // 中心暖亮
const SPARK_OUT = [215, 113, 77]; // Claude 橙 #D3734D ≈ #D97757 族

function shade(u, v, size) {
  // 底板圆角方
  const dPlate = sdRoundRect(u, v, 0.965, 0.965, 0.44) * (size / 2);
  const plateA = cov(dPlate);
  if (plateA <= 0) return null;
  // 底色：竖向渐变 + 左上微亮
  let c = mix3(BG_TOP, BG_BOT, clamp((v + 1) / 2 * 0.95 + Math.max(0, -u - v) * 0.04, 0, 1));
  // 1px 边缘 rim 高光
  c = mix3(c, RIM, cov(Math.abs(dPlate - 0.5) - 1.1) * 0.28);
  // 中心橙色光晕（叠加）
  const glow = Math.exp(-(u * u + v * v) / 0.16) * 0.30;
  c = [
    clamp(c[0] + 217 * glow, 0, 255),
    clamp(c[1] + 119 * glow, 0, 255),
    clamp(c[2] + 87 * glow, 0, 255),
  ];
  // 星芒
  let dSpark = Math.hypot(u, v) - DISC_R;
  for (const s of SPOKES) dSpark = Math.min(dSpark, sdSegment(u, v, s.ax, s.ay, s.bx, s.by) - s.r);
  const sparkA = cov(dSpark * (size / 2));
  if (sparkA > 0) {
    const sc = mix3(SPARK_IN, SPARK_OUT, clamp(Math.hypot(u, v) / 0.72, 0, 1));
    c = mix3(c, sc, sparkA);
  }
  return [c[0], c[1], c[2], plateA];
}

function render(size) {
  const AA = 4; // 4x4 超采样
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < AA; sy++) {
        for (let sx = 0; sx < AA; sx++) {
          const s = shade(
            ((x + (sx + 0.5) / AA) / size) * 2 - 1,
            ((y + (sy + 0.5) / AA) / size) * 2 - 1,
            size,
          );
          if (s) { r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3]; }
        }
      }
      const n = AA * AA, i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a); px[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return px;
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, encodePNG(size, size, render(size)));
  console.log("wrote", file);
}
