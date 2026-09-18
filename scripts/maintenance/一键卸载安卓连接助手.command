#!/bin/zsh -f
set -eu
umask 077
APP="$HOME/Applications/安卓连接助手.app"
ROOT="$HOME/Library/Application Support/AndroidLink"

fail(){ print -r -- "卸载已停止：$1"; read -r '?按回车关闭。'; exit 1; }
stop_assistant(){
  local lock="$ROOT/assistant.lock" pid command count=0
  [[ -f "$lock" && ! -L "$lock" ]] || return 0
  pid="$(/usr/bin/plutil -extract pid raw -o - "$lock" 2>/dev/null || true)"
  [[ "$pid" == <-> ]] || return 0
  /bin/kill -0 "$pid" 2>/dev/null || return 0
  command="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" != *'/AndroidLink/modules/code/'*'/wizard.mjs'* && "$command" != *'/安卓连接助手.app/Contents/Resources/wizard.mjs'* ]]; then
    fail '运行锁对应进程无法确认为安卓连接助手，为避免误杀已停止。'
  fi
  /bin/kill -TERM "$pid" 2>/dev/null || true
  while /bin/kill -0 "$pid" 2>/dev/null && (( count < 80 )); do /bin/sleep 0.1; (( count++ )) || true; done
  /bin/kill -0 "$pid" 2>/dev/null && fail '助手未能安全退出，请先手动关闭后重试。'
}

print '安卓连接助手 · 一键卸载'
print '将删除 App、本工具私有运行环境、缓存、日志、旧版本备份和 AI 临时文件。'
print '不会删除：~/Pictures/AndroidLink截图、~/Movies/安卓连接助手/录屏，以及 AI checkpoints。'
read -r 'answer?输入 uninstall 并回车确认卸载：'
[[ "$answer" == uninstall ]] || exit 0
stop_assistant
if [[ -e "$APP" ]]; then
  [[ -d "$APP" && ! -L "$APP" ]] || fail '应用路径异常。'
  ID="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true)"
  [[ "$ID" == local.androidlink.assistant ]] || fail '目标 App 不是安卓连接助手，没有删除。'
  /bin/rm -rf "$APP"
fi
if [[ -d "$ROOT" && ! -L "$ROOT" ]]; then
  for name in runtime stack android-sdk stream bin downloads logs backups config ipc run updates modules; do
    target="$ROOT/$name"
    [[ ! -e "$target" ]] || { [[ ! -L "$target" ]] || fail "发现异常符号链接：$target"; /bin/rm -rf "$target"; }
  done
  if [[ -d "$ROOT/ai" && ! -L "$ROOT/ai" ]]; then
    for name in audit artifacts; do [[ ! -e "$ROOT/ai/$name" ]] || /bin/rm -rf "$ROOT/ai/$name"; done
  fi
  /bin/rm -f "$ROOT/assistant.lock" "$ROOT/bootstrap.lock/pid" 2>/dev/null || true
  /bin/rmdir "$ROOT/bootstrap.lock" 2>/dev/null || true
  /bin/rmdir "$ROOT/ai" 2>/dev/null || true
  /bin/rmdir "$ROOT" 2>/dev/null || true
fi
print '\n卸载完成。用户截图、录屏和已有 AI 检查点已保留。'
read -r '?按回车关闭。'
