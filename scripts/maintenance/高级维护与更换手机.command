#!/bin/zsh -f
set -eu
APP="$HOME/Applications/安卓连接助手.app"
[[ -d "$APP" && ! -L "$APP" ]] || { print '尚未安装安卓连接助手。'; read -r '?按回车关闭。'; exit 1; }
exec /bin/zsh -f "$APP/Contents/Resources/bootstrap.zsh" menu
