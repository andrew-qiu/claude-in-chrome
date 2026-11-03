#!/usr/bin/env bash
# chrome-bridge 一键安装（多平台）
#   WSL(→Windows Chrome) / 纯 Linux / 纯 macOS / 纯 Windows(Git Bash)
#  1. 确保 bun → 按平台编译 native messaging host
#  2. 部署 host + extension
#  3. 计算 unpacked 扩展 ID，写 Native Messaging manifest（注册表 / 配置目录）
#  4. 注册 MCP server 到 ~/.claude.json
#  5. 端到端自测
# 幂等：可重复执行。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.user.chrome_bridge"
BRIDGE_PORT="${CHROME_BRIDGE_PORT:-8765}"
CLAUDE_JSON="$HOME/.claude.json"

say() { printf '\033[1;32m[chrome-bridge]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[chrome-bridge]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 平台检测
# ---------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux)  if grep -qi microsoft /proc/version 2>/dev/null; then OS=wsl; else OS=linux; fi ;;
  Darwin) OS=macos ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac
# 平台覆盖（测试/特殊部署用）：wsl | linux | macos | windows
if [ -n "${CHROME_BRIDGE_FORCE_OS:-}" ]; then
  case "$CHROME_BRIDGE_FORCE_OS" in wsl|linux|macos|windows) ;; *) die "CHROME_BRIDGE_FORCE_OS must be wsl|linux|macos|windows" ;; esac
  say "platform override: $CHROME_BRIDGE_FORCE_OS (detected: $OS)"
  OS="$CHROME_BRIDGE_FORCE_OS"
fi
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) ARCH=arm64 ;;
  *) ARCH=x64 ;;
esac

# Windows exe 必须在 /mnt/c 下执行（UNC cwd 会报错）——仅 WSL 需要
winexec() { ( cd /mnt/c && "$@" ); }

# sha256：macOS 无 sha256sum，用 shasum 兜底
hash32() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | head -c 32 | tr '0-9a-f' 'a-p'; }

say "platform: $OS ($ARCH)"

# ---------------------------------------------------------------------------
# 1. bun（编译工具链；无解压器时走 python zipfile 手动装）
# ---------------------------------------------------------------------------
case "$OS" in
  wsl|linux) BUN_PLAT=linux ;;
  macos)     BUN_PLAT=darwin ;;
  windows)   BUN_PLAT=windows ;;
esac
BUN_EXE=""
if [ "$OS" = windows ]; then BUN_EXE=".exe"; fi

if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/bun$BUN_EXE" ]; then
  say "installing bun to ~/.local/bin …"
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/bun.zip" "https://github.com/oven-sh/bun/releases/latest/download/bun-$BUN_PLAT-$ARCH.zip"
  if command -v unzip >/dev/null 2>&1; then
    (cd "$TMP" && unzip -q bun.zip)
    mkdir -p "$HOME/.local/bin"
    cp "$TMP/bun-$BUN_PLAT-$ARCH/bun$BUN_EXE" "$HOME/.local/bin/bun$BUN_EXE"
  else
    python3 - "$TMP" <<PY
import sys, zipfile, os, shutil
z = zipfile.ZipFile(os.path.join(sys.argv[1], "bun.zip"))
z.extractall(sys.argv[1])
os.makedirs(os.path.expanduser("~/.local/bin"), exist_ok=True)
shutil.copy(os.path.join(sys.argv[1], "bun-$BUN_PLAT-$ARCH", "bun$BUN_EXE"),
            os.path.expanduser("~/.local/bin/bun$BUN_EXE"))
PY
  fi
  chmod +x "$HOME/.local/bin/bun$BUN_EXE"
  rm -rf "$TMP"
fi
BUN="$(command -v bun 2>/dev/null || echo "$HOME/.local/bin/bun$BUN_EXE")"
[ -x "$BUN" ] || die "bun unavailable — install it to ~/.local/bin/bun first"
say "bun $($BUN --version)"

# ---------------------------------------------------------------------------
# 2. 编译 host + 部署（extension 与 host 同目录，manifest path 指向 host）
# ---------------------------------------------------------------------------
DEPLOY_DIR=""; WIN_DIR=""; HOST_BIN=""; HOST_WRAPPER=""
case "$OS" in
  wsl)
    # 自动探测 Windows 用户名（可用 WIN_USER 覆盖）
    if [ -z "${WIN_USER:-}" ]; then
      for d in /mnt/c/Users/*; do
        [ -d "$d" ] || continue
        u="$(basename "$d")"
        case "$u" in Public|Default|"Default User"|"All Users"|desktop.ini) continue ;; esac
        WIN_USER="$u"; break
      done
    fi
    [ -n "${WIN_USER:-}" ] || die "cannot detect Windows username — run with WIN_USER=<name>"
    WIN_DIR="C:\\Users\\$WIN_USER\\chrome-bridge"
    DEPLOY_DIR="/mnt/c/Users/$WIN_USER/chrome-bridge"
    BUILD_TARGET="bun-windows-x64"; HOST_BIN="host.exe" ;;
  windows)
    command -v cygpath >/dev/null 2>&1 || die "cygpath not found — run under Git Bash"
    WIN_DIR="$(cygpath -w "$USERPROFILE")\\chrome-bridge"
    DEPLOY_DIR="$(cygpath -u "$USERPROFILE")/chrome-bridge"
    BUILD_TARGET="bun-windows-x64"; HOST_BIN="host.exe" ;;
  linux|macos)
    DEPLOY_DIR="$HOME/.local/share/chrome-bridge"
    BUILD_TARGET="bun-$OS-$ARCH"; HOST_BIN="host" ;;
esac

say "building native host ($BUILD_TARGET)…"
"$BUN" build --compile --target="$BUILD_TARGET" "$ROOT/host/host.ts" --outfile "$ROOT/host/$HOST_BIN"

mkdir -p "$DEPLOY_DIR"
rm -f "$DEPLOY_DIR/$HOST_BIN.old"   # 清理上轮替换残留（此时旧实例已退出，可删）
if ! cp -f "$ROOT/host/$HOST_BIN" "$DEPLOY_DIR/$HOST_BIN" 2>/dev/null; then
  # Windows：运行中的 exe 被文件锁挡住 → 改名让路（运行中实例继续用旧文件，
  # 下次连接 Chrome 重新拉起新文件；扩展 5s 自动重连，无需退出 Chrome）
  mv "$DEPLOY_DIR/$HOST_BIN" "$DEPLOY_DIR/$HOST_BIN.old"
  cp -f "$ROOT/host/$HOST_BIN" "$DEPLOY_DIR/$HOST_BIN"
fi
rm -rf "$DEPLOY_DIR/extension"
cp -r "$ROOT/extension" "$DEPLOY_DIR/extension"

# Linux/macOS 的 manifest path 只能是可执行文件路径（不能带参数），用包装脚本固化连接地址；
# Windows 侧 host.exe 经 CHROME_BRIDGE_ADDR 环境变量拿地址（见第 4 步）
if [ "$OS" = linux ] || [ "$OS" = macos ]; then
  HOST_WRAPPER="$DEPLOY_DIR/chrome-bridge-host"
  cat > "$HOST_WRAPPER" <<EOF
#!/bin/sh
# chrome-bridge native messaging host launcher（install.sh 生成）
exec "\$(dirname "\$0")/$HOST_BIN" --bridge-host localhost --bridge-port $BRIDGE_PORT "\$@"
EOF
  chmod +x "$HOST_WRAPPER" "$DEPLOY_DIR/$HOST_BIN"
fi
say "deployed to ${WIN_DIR:-$DEPLOY_DIR}"

# ---------------------------------------------------------------------------
# 3. 扩展 ID：Chrome 对 unpacked 扩展用「部署目录绝对路径」生成 ID
#    id = SHA-256(路径编码) 前 16 字节 hex → 每半字节映射 a-p
#    Windows 路径用 UTF-16LE（宽字符串），POSIX 路径用 UTF-8 —— 混用会算错
# ---------------------------------------------------------------------------
if [ -n "${CHROME_EXT_ID:-}" ]; then
  EXT_ID="$CHROME_EXT_ID"
  say "extension id (override): $EXT_ID"
elif [ -n "$WIN_DIR" ]; then
  EXT_ID=$(printf '%s' "$WIN_DIR\\extension" | iconv -f UTF-8 -t UTF-16LE | hash32)
  say "unpacked extension id (expected): $EXT_ID from $WIN_DIR\\extension"
else
  EXT_ID=$(printf '%s' "$DEPLOY_DIR/extension" | hash32)
  say "unpacked extension id (expected): $EXT_ID from $DEPLOY_DIR/extension"
fi

# ---------------------------------------------------------------------------
# 4. Native Messaging manifest + 注册
#    Windows：注册表指向 manifest JSON；Linux/macOS：Chrome 用户配置目录放 JSON
# ---------------------------------------------------------------------------
write_manifest() { # $1 = 输出路径
  node -e '
const fs = require("fs");
const [hostPath, extId, out, name] = process.argv.slice(1);
// 保留旧 manifest 里已验证可用的 origins（防重装时把实际 ID 冲掉）
const origins = new Set(["chrome-extension://" + extId + "/"]);
try {
  const old = JSON.parse(fs.readFileSync(out, "utf8"));
  for (const o of old.allowed_origins ?? []) origins.add(o);
} catch {}
fs.writeFileSync(out, JSON.stringify({
  name,
  description: "chrome-bridge native host (AI browser control)",
  path: hostPath,
  type: "stdio",
  allowed_origins: [...origins],
}, null, 2));
' "$MANIFEST_HOST_PATH" "$EXT_ID" "$1" "$HOST_NAME"
}

if [ -n "$WIN_DIR" ]; then
  MANIFEST_HOST_PATH="$WIN_DIR\\$HOST_BIN"
  write_manifest "$DEPLOY_DIR/$HOST_NAME.json"
  if [ "$OS" = wsl ]; then
    REGEXE=/mnt/c/Windows/System32/reg.exe
    [ -x "$REGEXE" ] || die "reg.exe not found — WSL interop disabled?"
    winexec "$REGEXE" add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\$HOST_NAME" \
      /ve /t REG_SZ /d "$WIN_DIR\\$HOST_NAME.json" /f >/dev/null
  else
    reg.exe add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\$HOST_NAME" \
      /ve /t REG_SZ /d "$WIN_DIR\\$HOST_NAME.json" /f >/dev/null
  fi
  say "registry: HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\$HOST_NAME → $WIN_DIR\\$HOST_NAME.json"
else
  MANIFEST_HOST_PATH="$HOST_WRAPPER"
  NM_DIRS=()
  if [ "$OS" = linux ]; then
    NM_DIRS+=("$HOME/.config/google-chrome/NativeMessagingHosts")
    if [ -d "$HOME/.config/chromium/NativeMessagingHosts" ]; then NM_DIRS+=("$HOME/.config/chromium/NativeMessagingHosts"); fi
  else
    NM_DIRS+=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts")
    if [ -d "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ]; then NM_DIRS+=("$HOME/Library/Application Support/Chromium/NativeMessagingHosts"); fi
  fi
  for d in "${NM_DIRS[@]}"; do
    mkdir -p "$d"
    write_manifest "$d/$HOST_NAME.json"
    say "manifest: $d/$HOST_NAME.json → $MANIFEST_HOST_PATH"
  done
fi

# host.exe 连接地址（仅 Windows 侧需要：manifest path 不能带参数，走环境变量）
if [ "$OS" = wsl ] || [ "$OS" = windows ]; then
  BRIDGE_ADDR="localhost:$BRIDGE_PORT"
  if [ "$OS" = wsl ] && [ "${CHROME_BRIDGE_FORCE_WSL_IP:-0}" = "1" ]; then
    WSL_IP=$(ip -4 addr show eth0 | awk '/inet /{print $2}' | cut -d/ -f1)
    BRIDGE_ADDR="$WSL_IP:$BRIDGE_PORT"
    export CHROME_BRIDGE_HOST=0.0.0.0   # 同时让 WSL 侧 server 监听所有地址
  fi
  if [ "$OS" = wsl ]; then
    winexec /mnt/c/Windows/System32/cmd.exe /c "setx CHROME_BRIDGE_ADDR $BRIDGE_ADDR" >/dev/null
  else
    setx CHROME_BRIDGE_ADDR "$BRIDGE_ADDR" >/dev/null
  fi
  say "host.exe will connect to $BRIDGE_ADDR"
fi

# ---------------------------------------------------------------------------
# 5. MCP 注册
# ---------------------------------------------------------------------------
SERVER_JS="$ROOT/server/index.js"
if [ "$OS" = windows ]; then SERVER_JS="$(cygpath -w "$ROOT/server/index.js")"; fi
say "registering MCP server into $CLAUDE_JSON …"
node -e '
const fs = require("fs");
const p = process.argv[1];
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.mcpServers ??= {};
j.mcpServers["chrome-bridge"] = {
  command: "node",
  args: [process.argv[2]],
  env: process.env.CHROME_BRIDGE_HOST
    ? { CHROME_BRIDGE_HOST: process.env.CHROME_BRIDGE_HOST, CHROME_BRIDGE_PORT: process.env.CHROME_BRIDGE_PORT ?? "8765" }
    : { CHROME_BRIDGE_PORT: process.env.CHROME_BRIDGE_PORT ?? "8765" },
};
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log("mcpServers:", Object.keys(j.mcpServers).join(", "));
' "$CLAUDE_JSON" "$SERVER_JS"

# ---------------------------------------------------------------------------
# 6. selftest（server 本机起，host 直连验证）
#    端口已被持有（正在运行的会话）时跳过，避免重装把活会话的桥逐出
# ---------------------------------------------------------------------------
port_busy() { (ss -ltn 2>/dev/null || netstat -an 2>/dev/null) | grep -Eq "[:.]$BRIDGE_PORT[[:space:]]"; }
run_selftest() { # $1 = bridge host
  if [ "$OS" = wsl ]; then
    winexec "$DEPLOY_DIR/$HOST_BIN" --selftest --bridge-host "$1" --bridge-port "$BRIDGE_PORT" 2>/dev/null
  else
    "$DEPLOY_DIR/$HOST_BIN" --selftest --bridge-host "$1" --bridge-port "$BRIDGE_PORT" 2>/dev/null
  fi
}

if port_busy; then
  say "selftest skipped — port $BRIDGE_PORT already in use (running session owns the bridge)"
else
  say "running end-to-end selftest (local server ← native host)…"
  # sleep 管道保持 server stdin 打开（否则 server 立即退出）
  sleep 60 | node "$ROOT/server/index.js" 2>/tmp/chrome-bridge-selftest.log &
  SERVER_PID=$!
  sleep 1.5
  if run_selftest localhost; then
    say "selftest PASSED — native host reached the MCP server via localhost"
  elif [ "$OS" = wsl ]; then
    say "selftest FAILED on localhost — retrying with WSL IP…"
    WSL_IP=$(ip -4 addr show eth0 | awk '/inet /{print $2}' | cut -d/ -f1)
    if run_selftest "$WSL_IP"; then
      winexec /mnt/c/Windows/System32/cmd.exe /c "setx CHROME_BRIDGE_ADDR $WSL_IP:$BRIDGE_PORT" >/dev/null
      say "selftest PASSED via WSL IP $WSL_IP (addr saved; consider CHROME_BRIDGE_FORCE_WSL_IP=1 on reinstall)"
    else
      kill $SERVER_PID 2>/dev/null || true
      cat /tmp/chrome-bridge-selftest.log || true
      die "selftest failed both ways — check host.log beside the deployed host and that nothing else listens on :$BRIDGE_PORT"
    fi
  else
    kill $SERVER_PID 2>/dev/null || true
    cat /tmp/chrome-bridge-selftest.log || true
    die "selftest failed — check host.log beside the deployed host and that nothing else listens on :$BRIDGE_PORT"
  fi
  kill $SERVER_PID 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
say ""
say "安装完成。剩余手动步骤（一次性）："
if [ -n "$WIN_DIR" ]; then
  say "  1. Windows Chrome 打开 chrome://extensions"
  say "  2. 右上角开启「开发者模式」→「加载已解压的扩展程序」"
  say "     选择目录: $WIN_DIR\\extension"
else
  say "  1. Chrome 打开 chrome://extensions"
  say "  2. 右上角开启「开发者模式」→「加载已解压的扩展程序」"
  say "     选择目录: $DEPLOY_DIR/extension"
fi
say "  3. 完全退出并重启 Chrome"
say "  4. 重启 Claude Code 会话，调用 browser_status 验证（预期扩展 ID: $EXT_ID）"
