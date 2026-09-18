#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="0.5.6"
BUILD_DIR="$ROOT/build"
DIST_DIR="$ROOT/dist"
PACKAGE_NAME="AndroidLink-macOS-v${VERSION}"
PACKAGE_DIR="$BUILD_DIR/$PACKAGE_NAME"
APP="$PACKAGE_DIR/.payload/安卓连接助手.app"

rm -rf "$PACKAGE_DIR"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$PACKAGE_DIR/开发者资料/文档" "$PACKAGE_DIR/开发者资料/维护工具"

cp "$ROOT/packaging/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/packaging/launcher" "$APP/Contents/MacOS/launcher"
cp -R "$ROOT/src/." "$APP/Contents/Resources/"
chmod 755 "$APP/Contents/MacOS/launcher" "$APP/Contents/Resources/bootstrap.zsh" "$APP/Contents/Resources/连接手机.command"

cp "$ROOT/scripts/install-from-package.command" "$PACKAGE_DIR/安装安卓连接助手.command"
cp "$ROOT/scripts/open-assistant.command" "$PACKAGE_DIR/打开安卓连接助手.command"
chmod 755 "$PACKAGE_DIR/安装安卓连接助手.command" "$PACKAGE_DIR/打开安卓连接助手.command"

cp "$ROOT/docs/"*.md "$PACKAGE_DIR/开发者资料/文档/"
cp "$ROOT/scripts/maintenance/"*.command "$PACKAGE_DIR/开发者资料/维护工具/"
chmod 755 "$PACKAGE_DIR/开发者资料/维护工具/"*.command

cat > "$PACKAGE_DIR/使用说明.txt" <<'TXT'
Android Link for macOS v0.5.6

1. 双击“安装安卓连接助手.command”。
2. Android 手机开启“开发者选项 → USB 调试”，通过数据线连接 Mac。
3. 第一次连接时，在手机上允许 USB 调试授权。
4. 打开“安卓连接助手.app”或双击“打开安卓连接助手.command”。
5. 助手会自动打开默认浏览器，在控制页选择设备并连接。

控制服务只监听本机 127.0.0.1。
AI / MCP 接入、诊断和开发说明见“开发者资料”。
TXT

mkdir -p "$DIST_DIR"
ZIP="$DIST_DIR/${PACKAGE_NAME}.zip"
rm -f "$ZIP"

# Python zip writer avoids __MACOSX entries, preserves executable bits, and gives
# directories a real build timestamp instead of the ZIP 1980 fallback date.
python3 - "$PACKAGE_DIR" "$ZIP" <<'PY'
import os, stat, sys, time, zipfile
from pathlib import Path
src=Path(sys.argv[1]); out=Path(sys.argv[2])
now=time.localtime()[:6]
root_name=src.name
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for d, dirs, files in os.walk(src):
        dirs.sort(); files.sort()
        rel=Path(d).relative_to(src)
        arc_dir=(Path(root_name)/rel).as_posix().rstrip('/')+'/'
        zi=zipfile.ZipInfo(arc_dir, now)
        zi.create_system=3
        zi.external_attr=(stat.S_IFDIR|0o755)<<16
        z.writestr(zi,b'')
        for name in files:
            p=Path(d)/name
            arc=(Path(root_name)/rel/name).as_posix()
            st=p.stat()
            zi=zipfile.ZipInfo(arc,time.localtime(st.st_mtime)[:6])
            zi.create_system=3
            zi.external_attr=(stat.S_IFREG|(st.st_mode&0o777))<<16
            zi.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(zi,p.read_bytes())
print(out)
PY

echo "Built: $ZIP"
