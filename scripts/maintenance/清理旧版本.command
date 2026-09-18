#!/bin/zsh -f
set -eu
umask 077
ROOT="$HOME/Library/Application Support/AndroidLink"
APP_HOME="$HOME/Applications"
print '安卓连接助手 · 清理旧版本与安装残留'
print '会清理旧 App 私有备份、旧代码模块、旧 Node 运行时和遗留安装临时目录；不会删除当前 App、当前代码模块、截图、录屏或检查点。'
read -r 'answer?回车开始；输入 q 取消：'
[[ "$answer" != q ]] || exit 0
[[ ! -L "$ROOT" ]] || { print 'AndroidLink 目录异常，已停止。'; exit 1; }
ACTIVE=''
[[ -f "$ROOT/modules/active-code" && ! -L "$ROOT/modules/active-code" ]] && ACTIVE="$(<"$ROOT/modules/active-code")"
if [[ -d "$ROOT/backups" && ! -L "$ROOT/backups" ]]; then
  /usr/bin/find "$ROOT/backups" -mindepth 1 -maxdepth 1 -type d \( -name 'app-*' -o -name 'code-*' -o -name 'lock-*' \) -exec /bin/rm -rf {} + 2>/dev/null || true
fi
if [[ -d "$ROOT/modules/code" && ! -L "$ROOT/modules/code" ]]; then
  for dir in "$ROOT/modules/code"/*; do
    [[ -d "$dir" && ! -L "$dir" ]] || continue
    [[ "${dir:t}" == "$ACTIVE" ]] || /bin/rm -rf "$dir"
  done
fi
if [[ -d "$ROOT/runtime" && ! -L "$ROOT/runtime" ]]; then
  ARCH="$(/usr/bin/uname -m)"; [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]] && ARCH=arm64; [[ "$ARCH" != x86_64 ]] || ARCH=x64
  KEEP_NODE="node-v22.16.0-darwin-$ARCH"
  for dir in "$ROOT/runtime"/node-*; do [[ -d "$dir" && ! -L "$dir" ]] || continue; [[ "${dir:t}" == "$KEEP_NODE" ]] || /bin/rm -rf "$dir"; done
fi
for dir in "$APP_HOME"/.androidlink-stage-*; do [[ -d "$dir" && ! -L "$dir" ]] && /bin/rm -rf "$dir" || true; done
print '清理完成。'
read -r '?按回车关闭。'
