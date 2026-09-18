#!/bin/zsh -f
# AndroidLink private bootstrap. No sudo, no shell-profile changes, no system runtime replacement.
set -eu
umask 077
RESOURCE_DIR="${0:A:h}"
MODE="${1:-menu}"
ROOT_DIR="$HOME/Library/Application Support/AndroidLink"
NODE_VERSION='v22.16.0'
APP_TARGET="$HOME/Applications/安卓连接助手.app"
SELF_APP="${RESOURCE_DIR:h:h}"
APP_VERSION='0.5.6'
APP_BUILD='38'
BUNDLED_CODE_ID='0.5.6-build39'

app_alert() {
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'display alert "安卓连接助手" message (item 1 of argv) as warning buttons {"好"} default button "好"' \
    -e 'end run' -- "$1" >/dev/null 2>&1 || true
}

fail() {
  print -r -- "\n已暂停：$1"
  print '未修改系统 Node/Java/ADB，也未操作其他手机工具。处理后重新打开即可。'
  if [[ "$MODE" == app ]]; then app_alert "$1"; fi
  if [[ -t 0 ]]; then read -r '?按回车关闭。'; fi
  exit 1
}

validate_app_bundle() {
  local app="$1"
  [[ -d "$app" && ! -L "$app" ]] || fail '安装包中的 App 目录异常，请重新解压。'
  [[ -f "$app/Contents/Info.plist" && ! -L "$app/Contents/Info.plist" ]] || fail '安装包缺少 Info.plist，请重新解压。'
  local required
  for required in bootstrap.zsh core.mjs wizard.mjs control.mjs video-stream.mjs stream-client.mjs stream-recovery.mjs mjpeg-stream.mjs phone-recording.mjs control.html control.js control.css refresh-scheduler.mjs automation-errors.mjs automation-protocol.mjs automation-service.mjs control-lease.mjs ui-tree.mjs selectors.mjs runtime-spec-provider.mjs checkpoint.mjs ipc-server.mjs ipc-client.mjs cli.mjs mcp-server.mjs ai-integration.mjs update-manager.mjs component-manifest.json 连接手机.command; do
    [[ -f "$app/Contents/Resources/$required" && ! -L "$app/Contents/Resources/$required" ]] || fail "安装包缺少必需资源：$required。请重新解压。"
  done
  for required in ipc-request.schema.json ipc-response.schema.json snapshot.schema.json selector.schema.json runtime-spec.schema.json; do
    [[ -f "$app/Contents/Resources/schemas/$required" && ! -L "$app/Contents/Resources/schemas/$required" ]] || fail "安装包缺少 AI 工具协议资源：schemas/$required。请重新解压。"
  done
  [[ -f "$app/Contents/MacOS/launcher" && ! -L "$app/Contents/MacOS/launcher" ]] || fail '安装包缺少启动器，请重新解压。'
}

safe_active_code_id() {
  [[ "$1" =~ '^[A-Za-z0-9._+-]{1,64}$' ]]
}

seed_code_bundle() {
  local app="$1" modules="$ROOT_DIR/modules" code_root="$ROOT_DIR/modules/code" target="$ROOT_DIR/modules/code/$BUNDLED_CODE_ID" stage
  [[ ! -L "$modules" && ! -L "$code_root" ]] || fail '模块目录是符号链接，已停止安装。'
  /bin/mkdir -p "$code_root"
  if [[ -e "$target" ]]; then
    [[ -d "$target" && ! -L "$target" ]] || fail '现有代码模块目录异常，已停止安装。'
    local archive
    archive="$(/usr/bin/mktemp -d "$ROOT_DIR/backups/code-XXXXXXXX")"
    /bin/mv "$target" "$archive/$BUNDLED_CODE_ID"
  fi
  stage="$(/usr/bin/mktemp -d "$code_root/.seed-XXXXXXXX")"
  /usr/bin/ditto "$app/Contents/Resources" "$stage/payload" || fail '复制 App 代码模块失败。'
  [[ -f "$stage/payload/wizard.mjs" && -f "$stage/payload/component-manifest.json" && ! -L "$stage/payload" ]] || fail '代码模块完整性检查失败。'
  /bin/mv "$stage/payload" "$target" || fail '安装代码模块失败。'
  /bin/rmdir "$stage" 2>/dev/null || true
  local pointer_tmp="$modules/.active-code.tmp-$$"
  print -r -- "$BUNDLED_CODE_ID" > "$pointer_tmp"
  /bin/chmod 600 "$pointer_tmp"
  /bin/mv -f "$pointer_tmp" "$modules/active-code"
}

resolve_code_dir() {
  local pointer="$ROOT_DIR/modules/active-code" value dir
  if [[ -f "$pointer" && ! -L "$pointer" ]]; then
    value="$(<"$pointer")"
    if safe_active_code_id "$value"; then
      dir="$ROOT_DIR/modules/code/$value"
      if [[ -d "$dir" && ! -L "$dir" && -f "$dir/wizard.mjs" && -f "$dir/component-manifest.json" ]]; then
        print -r -- "$dir"
        return 0
      fi
    fi
  fi
  print -r -- "$RESOURCE_DIR"
}

stop_running_assistant() {
  local lock="$ROOT_DIR/assistant.lock" pid command count=0
  [[ -f "$lock" && ! -L "$lock" ]] || return 0
  pid="$(/usr/bin/plutil -extract pid raw -o - "$lock" 2>/dev/null || true)"
  [[ "$pid" == <-> ]] || return 0
  /bin/kill -0 "$pid" 2>/dev/null || return 0
  command="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" != *'/AndroidLink/modules/code/'*'/wizard.mjs'* && "$command" != *'/安卓连接助手.app/Contents/Resources/wizard.mjs'* ]]; then
    fail '检测到运行锁，但对应进程无法确认为安卓连接助手；为避免误杀进程，已停止更新。'
  fi
  print '检测到旧版助手正在运行，正在安全停止后自动替换…'
  /bin/kill -TERM "$pid" 2>/dev/null || true
  while /bin/kill -0 "$pid" 2>/dev/null && (( count < 80 )); do /bin/sleep 0.1; (( count++ )) || true; done
  /bin/kill -0 "$pid" 2>/dev/null && fail '旧版助手未能在 8 秒内安全退出；请手动关闭后重试。'
  if [[ -f "$lock" && "$(/usr/bin/plutil -extract pid raw -o - "$lock" 2>/dev/null || true)" == "$pid" ]]; then /bin/rm -f "$lock"; fi
}

assistant_pid() {
  local pid="$1" command
  command="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *'/AndroidLink/modules/code/'*'/wizard.mjs'* ||
     "$command" == *'/安卓连接助手.app/Contents/Resources/wizard.mjs'* ]]
}

open_existing_control_page() {
  local url_file="$ROOT_DIR/run/control-url" url base attempt
  for attempt in {1..30}; do
    if [[ -f "$url_file" && ! -L "$url_file" ]]; then
      url="$(<"$url_file")"
      if [[ "$url" == http://127.0.0.1:*#* ]]; then
        base="${url%%#*}"
        if /usr/bin/curl --silent --show-error --fail --max-time 1 "$base" >/dev/null 2>&1; then
          if /usr/bin/open "$url" >/dev/null 2>&1; then return 0; fi
          /usr/bin/osascript -e 'on run argv' -e 'open location (item 1 of argv)' -e 'end run' -- "$url" >/dev/null 2>&1 && return 0
        fi
      fi
    fi
    /bin/sleep 0.1
  done
  return 1
}

[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail '本发行包仅支持 macOS。'
[[ "$(/usr/bin/id -u)" != 0 ]] || fail '请用自己的普通账户打开，不要使用 root 或 sudo。'
MAC_MAJOR="$(/usr/bin/sw_vers -productVersion | /usr/bin/cut -d . -f 1)"
(( MAC_MAJOR >= 12 )) || fail '此版本支持 macOS 12 Monterey 及以上。'
[[ ! -L "$ROOT_DIR" ]] || fail '专用数据目录是符号链接，已停止。'
/bin/mkdir -p "$ROOT_DIR/backups" "$ROOT_DIR/run" "$ROOT_DIR/modules/code"
/bin/chmod 700 "$ROOT_DIR" "$ROOT_DIR/run" "$ROOT_DIR/modules" "$ROOT_DIR/modules/code" 2>/dev/null || true

# Daily App launch is idempotent. Only trust a lock when the PID is really our wizard process
# and the published localhost page is reachable; stale/reused PID locks are self-healed.
if [[ "$MODE" == app && -f "$ROOT_DIR/assistant.lock" && ! -L "$ROOT_DIR/assistant.lock" ]]; then
  ACTIVE_PID="$(/usr/bin/plutil -extract pid raw -o - "$ROOT_DIR/assistant.lock" 2>/dev/null || true)"
  if [[ "$ACTIVE_PID" == <-> ]] && /bin/kill -0 "$ACTIVE_PID" 2>/dev/null; then
    if assistant_pid "$ACTIVE_PID"; then
      open_existing_control_page || fail '安卓连接助手正在启动，但控制页尚未就绪。请稍后再次打开。'
      exit 0
    fi
    /bin/rm -f "$ROOT_DIR/assistant.lock" "$ROOT_DIR/run/control-url"
  else
    /bin/rm -f "$ROOT_DIR/assistant.lock" "$ROOT_DIR/run/control-url"
  fi
fi

BOOT_LOCK="$ROOT_DIR/bootstrap.lock"
release_boot_lock() {
  if [[ -f "$BOOT_LOCK/pid" && "$(<"$BOOT_LOCK/pid")" == "$$" ]]; then
    /bin/rm -f "$BOOT_LOCK/pid"
    /bin/rmdir "$BOOT_LOCK" 2>/dev/null || true
  fi
}
if [[ -e "$BOOT_LOCK" ]]; then
  [[ ! -L "$BOOT_LOCK" && -f "$BOOT_LOCK/pid" ]] || fail '发现异常启动锁，请保留现场并联系维护者。'
  LOCK_PID="$(<"$BOOT_LOCK/pid")"
  [[ "$LOCK_PID" == <-> ]] || fail '启动锁格式异常。'
  if /bin/kill -0 "$LOCK_PID" 2>/dev/null; then fail '另一个安装或启动任务仍在运行。'; fi
  STALE_DIR="$(/usr/bin/mktemp -d "$ROOT_DIR/backups/lock-XXXXXXXX")"
  /bin/mv "$BOOT_LOCK" "$STALE_DIR/bootstrap.lock" || fail '无法保留旧启动锁。'
fi
/bin/mkdir "$BOOT_LOCK" 2>/dev/null || fail '另一个启动任务刚刚开始，请稍后重试。'
print -r -- "$$" > "$BOOT_LOCK/pid"
trap release_boot_lock EXIT
trap 'exit 130' INT TERM HUP

if [[ "$MODE" == install ]]; then
  print "\n安卓连接助手 $APP_VERSION · 轻量浏览器版"
  print '日常打开“安卓连接助手.app”或“打开安卓连接助手.command”；控制界面会在默认浏览器中打开。'
  print '新版本会自动安全停止并替换旧 App；旧 App 只保留在私有回滚目录，不会在“应用程序”里并存。'
  print '运行依赖放在 AndroidLink 私有目录，不修改系统 Node/Java/ADB/Appium。'
  print '安装阶段不需要连接手机；安装完成后再打开助手，在浏览器设备大厅中按需手动连接设备。'
  read -r 'answer?回车开始安装；输入 q 取消：'
  [[ "$answer" != q ]] || exit 0
  SOURCE_APP="${2:?missing app source}"
  validate_app_bundle "$SOURCE_APP"
  stop_running_assistant
  [[ ! -L "$APP_TARGET" ]] || fail '目标应用是符号链接，已停止。'
  /bin/mkdir -p "$HOME/Applications"
  APP_STAGE="$(/usr/bin/mktemp -d "$HOME/Applications/.androidlink-stage-XXXXXXXX")"
  /usr/bin/ditto "$SOURCE_APP" "$APP_STAGE/安卓连接助手.app" || fail '复制应用失败，现有应用未更改。'
  validate_app_bundle "$APP_STAGE/安卓连接助手.app"
  /usr/bin/plutil -lint "$APP_STAGE/安卓连接助手.app/Contents/Info.plist" >/dev/null || fail '应用清单格式异常。'
  /bin/chmod u+x "$APP_STAGE/安卓连接助手.app/Contents/MacOS/launcher" "$APP_STAGE/安卓连接助手.app/Contents/Resources/bootstrap.zsh"
  if [[ -e "$APP_TARGET" ]]; then
    EXISTING_ID="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$APP_TARGET/Contents/Info.plist" 2>/dev/null || true)"
    [[ "$EXISTING_ID" == local.androidlink.assistant ]] || fail '存在同名但不是本工具的应用，没有覆盖。'
    ARCHIVE_DIR="$(/usr/bin/mktemp -d "$ROOT_DIR/backups/app-XXXXXXXX")"
    /bin/mv "$APP_TARGET" "$ARCHIVE_DIR/安卓连接助手.app"
    print -r -- "旧 App 已进入私有回滚目录：$ARCHIVE_DIR"
  fi
  /bin/mv "$APP_STAGE/安卓连接助手.app" "$APP_TARGET" || fail '放置应用失败。'
  /bin/rmdir "$APP_STAGE" 2>/dev/null || true
  validate_app_bundle "$APP_TARGET"
  seed_code_bundle "$APP_TARGET"
  print -r -- "已安装并替换为：$APP_TARGET"
  release_boot_lock
  exec /bin/zsh -f "$APP_TARGET/Contents/Resources/bootstrap.zsh" provision
fi

/bin/mkdir -p "$ROOT_DIR/runtime" "$ROOT_DIR/downloads"
NODE_ARCH="$(/usr/bin/uname -m)"
if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then NODE_ARCH=arm64; fi
[[ "$NODE_ARCH" != x86_64 ]] || NODE_ARCH=x64
[[ "$NODE_ARCH" == arm64 || "$NODE_ARCH" == x64 ]] || fail '暂不支持这种 Mac 芯片架构。'
NODE_DIR="$ROOT_DIR/runtime/node-$NODE_VERSION-darwin-$NODE_ARCH"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  [[ "$MODE" != app ]] || fail '专用运行环境尚未安装完整。请重新运行完整安装包里的“安装安卓连接助手.command”。'
  print '\n需要安装本工具专用的 Node.js（不影响系统 Node）。'
  read -r 'answer?回车下载；输入 q 暂停：'
  [[ "$answer" != q ]] || exit 0
  [[ ! -e "$NODE_DIR" ]] || fail '发现未完成的 Node 目录，未自动删除。'
  STAGE="$(/usr/bin/mktemp -d "$ROOT_DIR/downloads/node-XXXXXXXX")"
  ARCHIVE="node-$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
  DOWNLOAD_BASE="https://nodejs.org/dist/$NODE_VERSION"
  print '正在从 Node.js 官网下载，并按官网 SHA-256 清单校验。'
  /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 900 --retry 2 --progress-bar "$DOWNLOAD_BASE/$ARCHIVE" -o "$STAGE/$ARCHIVE" || fail 'Node.js 下载失败。'
  /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --retry 2 --silent --show-error "$DOWNLOAD_BASE/SHASUMS256.txt" -o "$STAGE/SHASUMS256.txt" || fail '无法取得 Node.js 官网校验文件。'
  EXPECTED="$(/usr/bin/awk -v name="$ARCHIVE" '$2 == name {print $1}' "$STAGE/SHASUMS256.txt")"
  ACTUAL="$(/usr/bin/shasum -a 256 "$STAGE/$ARCHIVE" | /usr/bin/awk '{print $1}')"
  [[ ${#EXPECTED} == 64 && "$EXPECTED" == "$ACTUAL" ]] || fail 'Node.js 下载校验失败，未运行下载内容。'
  /usr/bin/tar -xzf "$STAGE/$ARCHIVE" -C "$STAGE" || fail '解压 Node.js 失败。'
  "$STAGE/node-$NODE_VERSION-darwin-$NODE_ARCH/bin/node" --version || fail 'Node.js 无法运行。'
  /bin/mv "$STAGE/node-$NODE_VERSION-darwin-$NODE_ARCH" "$NODE_DIR" || fail '移动 Node.js 失败。'
  [[ "$STAGE" == "$ROOT_DIR/downloads/node-"* && -d "$STAGE" && ! -L "$STAGE" ]] || fail 'Node.js 临时目录校验失败，未清理。'
  /bin/rm -rf "$STAGE"
fi
export PATH="$NODE_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# A full App install seeds an external code bundle. This keeps the App shell stable and lets future signed builds update code by atomic pointer swap.
if [[ ! -f "$ROOT_DIR/modules/active-code" || -L "$ROOT_DIR/modules/active-code" ]]; then
  CODE_SOURCE="$APP_TARGET"
  if [[ ! -d "$CODE_SOURCE" || -L "$CODE_SOURCE" ]]; then CODE_SOURCE="$SELF_APP"; fi
  [[ -d "$CODE_SOURCE" && ! -L "$CODE_SOURCE" ]] || fail '未找到可用的安卓连接助手 App。'
  validate_app_bundle "$CODE_SOURCE"
  seed_code_bundle "$CODE_SOURCE"
fi
CODE_DIR="$(resolve_code_dir)"

# Private CLI / MCP entrypoints. They always follow the active code pointer and never modify shell profiles.
BIN_DIR="$ROOT_DIR/bin"
[[ ! -L "$BIN_DIR" ]] || fail 'AI 工具命令目录是符号链接，已停止。'
/bin/mkdir -p "$BIN_DIR"
/bin/chmod 700 "$BIN_DIR"
cat > "$BIN_DIR/android-link" <<'EOS'
#!/bin/zsh -f
set -eu
ROOT="$HOME/Library/Application Support/AndroidLink"
ARCH="$(/usr/bin/uname -m)"
if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then ARCH=arm64; fi
[[ "$ARCH" != x86_64 ]] || ARCH=x64
NODE="$ROOT/runtime/node-v22.16.0-darwin-$ARCH/bin/node"
POINTER="$ROOT/modules/active-code"
CODE=''
if [[ -f "$POINTER" && ! -L "$POINTER" ]]; then ID="$(<"$POINTER")"; [[ "$ID" =~ '^[A-Za-z0-9._+-]{1,64}$' ]] && CODE="$ROOT/modules/code/$ID"; fi
[[ -d "$CODE" && ! -L "$CODE" ]] || CODE="$HOME/Applications/安卓连接助手.app/Contents/Resources"
[[ -x "$NODE" && -f "$CODE/cli.mjs" ]] || { print -u2 '安卓连接助手尚未完成安装，请先运行完整安装器。'; exit 3; }
exec "$NODE" "$CODE/cli.mjs" "$@"
EOS
cat > "$BIN_DIR/android-link-mcp" <<'EOS'
#!/bin/zsh -f
set -eu
ROOT="$HOME/Library/Application Support/AndroidLink"
ARCH="$(/usr/bin/uname -m)"
if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then ARCH=arm64; fi
[[ "$ARCH" != x86_64 ]] || ARCH=x64
NODE="$ROOT/runtime/node-v22.16.0-darwin-$ARCH/bin/node"
POINTER="$ROOT/modules/active-code"
CODE=''
if [[ -f "$POINTER" && ! -L "$POINTER" ]]; then ID="$(<"$POINTER")"; [[ "$ID" =~ '^[A-Za-z0-9._+-]{1,64}$' ]] && CODE="$ROOT/modules/code/$ID"; fi
[[ -d "$CODE" && ! -L "$CODE" ]] || CODE="$HOME/Applications/安卓连接助手.app/Contents/Resources"
[[ -x "$NODE" && -f "$CODE/mcp-server.mjs" ]] || { print -u2 '安卓连接助手尚未完成安装，请先运行完整安装器。'; exit 3; }
exec "$NODE" "$CODE/mcp-server.mjs" "$@"
EOS
/bin/chmod 700 "$BIN_DIR/android-link" "$BIN_DIR/android-link-mcp"

release_boot_lock
exec "$NODE_DIR/bin/node" "$CODE_DIR/wizard.mjs" "$MODE"
