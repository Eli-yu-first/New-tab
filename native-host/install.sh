#!/bin/bash
# ======================================================================
#  install.sh — 为各 Chromium 浏览器安装 Native Messaging Host
#
#  用法:  chmod +x install.sh && ./install.sh
#
#  安装后，New Tab 扩展即可通过 Native Messaging 读写共享文件
#  (~/.newtab_sync/data.json)，实现跨浏览器同步。
# ======================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/run.sh"
HOST_NAME="com.newtab.sync"

# 确保所有脚本可执行
chmod +x "$SCRIPT_DIR/host.js"
chmod +x "$HOST_PATH"

echo "======================================"
echo "  New Tab 跨浏览器同步 — 安装脚本"
echo "======================================"
echo ""
echo "请在每个浏览器的扩展管理页面中获取扩展 ID："
echo "  Chrome → chrome://extensions"
echo "  Edge   → edge://extensions"
echo "  Brave  → brave://extensions"
echo ""

# ── 收集扩展 ID ──────────────────────────────────────────────────

ORIGINS=""
INSTALLED=0

read -p "Chrome 扩展 ID (留空跳过): " CHROME_ID
read -p "Edge   扩展 ID (留空跳过): " EDGE_ID
read -p "Brave  扩展 ID (留空跳过): " BRAVE_ID
read -p "Doubao 扩展 ID (留空跳过): " DOUBAO_ID

if [ -z "$CHROME_ID" ] && [ -z "$EDGE_ID" ] && [ -z "$BRAVE_ID" ] && [ -z "$DOUBAO_ID" ]; then
  echo ""
  echo "❌ 错误: 至少需要提供一个扩展 ID"
  exit 1
fi

# 构建 allowed_origins 列表
build_origins() {
  local first=true
  ORIGINS="["
  for eid in "$@"; do
    if [ -n "$eid" ]; then
      if [ "$first" = true ]; then
        first=false
      else
        ORIGINS="$ORIGINS, "
      fi
      ORIGINS="$ORIGINS\"chrome-extension://$eid/\""
    fi
  done
  ORIGINS="$ORIGINS]"
}

build_origins "$CHROME_ID" "$EDGE_ID" "$BRAVE_ID" "$DOUBAO_ID"

# 生成 manifest JSON
MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "New Tab extension cross-browser data synchronization",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": $ORIGINS
}
EOF
)

echo ""
echo "正在安装 Native Messaging Host..."

# ── 安装到各浏览器 ────────────────────────────────────────────────

install_for_browser() {
  local name="$1"
  local dir="$2"
  mkdir -p "$dir"
  echo "$MANIFEST" > "$dir/$HOST_NAME.json"
  echo "  ✅ $name — 已安装"
  INSTALLED=$((INSTALLED + 1))
}

if [ -n "$CHROME_ID" ]; then
  install_for_browser "Chrome" "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
fi

if [ -n "$EDGE_ID" ]; then
  install_for_browser "Edge  " "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
fi

if [ -n "$BRAVE_ID" ]; then
  install_for_browser "Brave " "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
fi

if [ -n "$DOUBAO_ID" ]; then
  install_for_browser "Doubao" "$HOME/Library/Application Support/Doubao/NativeMessagingHosts"
fi

# 创建共享数据目录
mkdir -p "$HOME/.newtab_sync"

echo ""
echo "======================================"
echo "  ✅ 安装完成！已配置 $INSTALLED 个浏览器"
echo "======================================"
echo ""
echo "共享数据文件: ~/.newtab_sync/data.json"
echo ""
echo "⚠️  请重启所有浏览器以使更改生效。"
