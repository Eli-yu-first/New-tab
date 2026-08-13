#!/bin/bash
# ======================================================================
#  run.sh — Native Messaging Host 启动包装脚本
#
#  解决 macOS GUI 应用（如 Chrome/豆包）在启动原生消息主机时，
#  由于环境变量 PATH 不含 Homebrew 路径（/opt/homebrew/bin）
#  而导致无法识别 'node' 的经典问题。
# ======================================================================

# 自动把 Homebrew 和常用 Node 路径追加到 PATH 环境变量
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# 获取当前脚本所在文件夹的绝对路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 执行实际的 Node.js 宿主代码，并原样透传标准输入输出及参数
exec node "$SCRIPT_DIR/host.js" "$@"
