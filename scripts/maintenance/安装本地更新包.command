#!/bin/zsh -f
set -eu
umask 077
ROOT="$HOME/Library/Application Support/AndroidLink"
APP="$HOME/Applications/安卓连接助手.app"
[[ -d "$APP" && ! -L "$APP" ]] || { print '尚未安装安卓连接助手。'; read -r '?按回车关闭。'; exit 1; }
PATCH="${1:-}"
if [[ -z "$PATCH" ]]; then
  PATCH="$(/usr/bin/osascript -e 'POSIX path of (choose file with prompt "选择 AndroidLink 本地更新包 ZIP")' 2>/dev/null || true)"
fi
[[ -n "$PATCH" && -f "$PATCH" && ! -L "$PATCH" ]] || { print '没有选择有效更新包。'; exit 1; }
case "$PATCH" in *.zip) ;; *) print '更新包必须是 ZIP。'; exit 1;; esac
ARCH="$(/usr/bin/uname -m)"; [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]] && ARCH=arm64; [[ "$ARCH" != x86_64 ]] || ARCH=x64
NODE="$ROOT/runtime/node-v22.16.0-darwin-$ARCH/bin/node"
POINTER="$ROOT/modules/active-code"
[[ -x "$NODE" && -f "$POINTER" && ! -L "$POINTER" ]] || { print '运行环境未准备好，请先完整安装。'; exit 1; }
ID="$(<"$POINTER")"
CODE="$ROOT/modules/code/$ID"
[[ -d "$CODE" && ! -L "$CODE" && -f "$CODE/update-manager.mjs" ]] || { print '当前代码模块异常，请使用完整安装包修复。'; exit 1; }
STAGE="$(/usr/bin/mktemp -d "$ROOT/updates/local-XXXXXXXX")"
cleanup(){ [[ -d "$STAGE" && ! -L "$STAGE" ]] && /bin/rm -rf "$STAGE" || true; }
trap cleanup EXIT INT TERM HUP
/usr/bin/ditto -x -k "$PATCH" "$STAGE"
PATCH_DIR="$STAGE"
[[ -f "$PATCH_DIR/patch-manifest.json" ]] || {
  entries=("$STAGE"/*(N/)); [[ ${#entries[@]} -eq 1 && -f "$entries[1]/patch-manifest.json" ]] && PATCH_DIR="$entries[1]"
}
"$NODE" "$CODE/update-manager.mjs" verify "$PATCH_DIR" || { print '更新包验证失败，没有修改当前版本。'; exit 1; }
print '更新包验证通过。安装后需要重新启动助手才会生效。'
"$NODE" "$CODE/update-manager.mjs" apply "$PATCH_DIR" || { print '更新失败，当前 active-code 未切换。'; exit 1; }
print '更新已原子安装；旧代码仍保留用于回滚。正在重新启动助手…'
LOCK="$ROOT/assistant.lock"
if [[ -f "$LOCK" && ! -L "$LOCK" ]]; then
  PID="$(/usr/bin/plutil -extract pid raw -o - "$LOCK" 2>/dev/null || true)"
  if [[ "$PID" == <-> ]] && /bin/kill -0 "$PID" 2>/dev/null; then /bin/kill -TERM "$PID" 2>/dev/null || true; /bin/sleep 1; fi
fi
/usr/bin/open "$APP"
read -r '?按回车关闭。'
