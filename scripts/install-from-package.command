#!/bin/zsh -f
set -eu
HERE="${0:A:h}"
PAYLOAD="$HERE/.payload/安卓连接助手.app"
if [[ ! -d "$PAYLOAD" || -L "$PAYLOAD" ]]; then
  print '安装包不完整：缺少运行组件。请重新解压完整 ZIP。'
  read -r '?按回车关闭。'
  exit 1
fi
exec /bin/zsh -f "$PAYLOAD/Contents/Resources/bootstrap.zsh" install "$PAYLOAD"
