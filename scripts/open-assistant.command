#!/bin/zsh -f
set -eu
CANDIDATES=(
  "$HOME/Applications/安卓连接助手.app"
  "/Applications/安卓连接助手.app"
)
for APP in "${CANDIDATES[@]}"; do
  if [[ -d "$APP" && ! -L "$APP" && -f "$APP/Contents/MacOS/launcher" ]]; then
    exec /usr/bin/open "$APP"
  fi
done
print '尚未安装安卓连接助手。请先双击“安装安卓连接助手.command”。'
read -r '?按回车关闭。'
exit 1
