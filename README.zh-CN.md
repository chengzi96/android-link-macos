# Android Link for macOS

[English](./README.md)

Android Link 是一个面向 macOS 的轻量 Android 真机连接与控制工具。手机连接后，可以直接在本机浏览器里查看、操作 Android 真机；同时通过 **MCP** 和 CLI，把同一台手机、同一个控制 Session 提供给支持 MCP 的 AI 使用。

> 当前公开版本：**v0.5.6** · macOS 12+ · 支持 Apple Silicon / Intel

**只想先试用？** 可以直接从 [GitHub Releases](../../releases/latest) 下载已经打好的安装 ZIP；Release 里也会同时提供经过清理的源码 ZIP。

## 它解决什么问题

它不只是一个投屏工具，也不只是一个 Appium 启动器。核心设计是让**人工控制和 AI 自动化共用同一套真机 Session**：

```text
人工 → 浏览器 ─┐
               ├→ Android Link → Appium / ADB → Android 真机
AI → MCP / CLI ─┘
```

这样 AI 不需要再单独启动第二套 Appium Session，也不会和浏览器人工操作抢占同一台设备。

## 主要功能

- USB / ADB 自动发现 Android 真机
- 浏览器实时查看并控制手机
- 点击、拖拽、四向滑动、文字输入
- 返回、Home、最近任务
- 打开通知栏、快捷设置、收起系统面板
- 保存原始截图、手机端原生录屏
- 读取 Android UI Tree / 页面结构
- 优先使用 H.264，失败时自动回退 MJPEG
- scrcpy 跟手触控失败时自动回退 Appium 手势
- 实时监测 ADB、Session、视频流、触控状态
- 一键导出经过脱敏的诊断文件
- 内置本地 stdio MCP Server
- Codex、Cursor 及其他支持 MCP 的 AI 可复用当前真机 Session

## 使用要求

- macOS 12 或更高版本
- Apple Silicon（`arm64`）或 Intel（`x64`）Mac
- Android 8 / API 26 或更高版本
- 手机已开启 USB 调试
- 支持数据传输的 USB 线

助手会尽量使用自己的本地运行环境，不会为了运行本工具去替换系统 Node、Java 或 ADB。

## 快速开始

### 1. 构建安装包

下载或克隆仓库后，在 macOS 执行：

```bash
./scripts/build-release.sh
```

生成的安装包会放在 `dist/`。

### 2. 安装

解压安装包，双击：

```text
安装安卓连接助手.command
```

安装后会生成或替换：

```text
~/Applications/安卓连接助手.app
```

不会并存多个版本。

### 3. 连接手机

1. 在 Android 手机上开启 **开发者选项 → USB 调试**。
2. 使用 USB 数据线连接 Mac。
3. 手机第一次连接时，允许“USB 调试”授权。
4. 打开 `安卓连接助手.app`。
5. 助手会启动本机服务，并自动在默认浏览器打开控制页面。
6. 选择识别到的 Android 手机并连接。

控制服务只监听 **127.0.0.1**，不会直接开放到局域网。

## 日常操作

连接后可以直接使用：

- 点击手机画面
- 鼠标拖拽 / 四向滑动
- 输入文字
- 返回 / Home / 最近任务
- 通知栏 / 快捷设置 / 收起面板
- 保存截图 / 开始录屏
- 查看 UI Tree
- 高级检查与实时诊断

## AI / MCP 接入

Android Link 内置本地 stdio MCP Server。

在控制页面的 **AI 接入** 模块中，可以：

- 自动识别部分本地 AI 客户端；
- 对支持的客户端一键接入；
- 复制通用 JSON MCP 配置；
- 复制 TOML MCP 配置；
- 复制 MCP 启动命令；
- 独立测试 MCP 是否能正常连接安卓助手。

接入后，AI 可以调用 Android Link 提供的真机工具，例如：

- 查看当前手机状态和截图
- 读取 UI Tree
- 点击 / 滑动 / 拖拽
- 输入文字
- 返回 / Home
- 打开通知栏和快捷设置
- 收起系统面板
- 保存检查节点

例如可以直接对 AI 说：

> 查看当前连接的 Android 手机，打开快捷设置，确认当前页面后截图，然后收起面板。

更详细的配置见 [MCP 与 AI 接入说明](./docs/MCP.zh-CN.md)。

## 隐私与安全

这个项目按“本地优先”设计：

- 浏览器控制服务只监听 `127.0.0.1`。
- AI 工具层通过当前用户目录下的 Unix Domain Socket 通信。
- IPC Secret 在运行时随机生成，并使用严格的本地文件权限。
- 手机序列号、输入文字、控制页面 Token 会作为敏感运行数据处理。
- 导出的诊断文件不会主动包含截图、UI Tree、输入文字、控制 Token 或原始 ADB 序列号。
- 公开仓库已经清理私人账号凭据、项目内部标识、个人路径或真实设备标识。

详见 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)。

## 当前已知限制

v0.5.6 已经可以日常使用，但不同 Android 设备 / ROM 仍可能存在兼容差异：

- 部分设备 H.264 无法建立，会自动回退 MJPEG。
- 部分设备 scrcpy 实时触控无法建立，会自动回退 Appium。
- Appium 兼容模式下的拖动属于“松手后执行”，不是真正实时跟手。
- 不同厂商 ROM 对系统面板、USB 调试和自动化权限的实现可能不同。
- 当前 macOS App 是轻量本地启动器，不是 App Store / 公证商业发行包。

详见 [KNOWN_ISSUES.zh-CN.md](./KNOWN_ISSUES.zh-CN.md)。

## 开发与测试

项目单元测试本身不依赖第三方 npm 包：

```bash
npm test
```

发布脚本会从 `src/` 与 `packaging/` 组装 macOS `.app`，再生成轻量安装包。

## 参与开发

欢迎提交 Bug、设备/ROM 兼容结果、修复和 Pull Request。公开 Issue 时请不要上传真实 ADB 序列号、包含个人信息的截图、账号密码或其他认证信息。

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 开源协议

采用 MIT License。允许自由使用、修改、分发、二次开发和商业使用，但需要保留原始版权与许可证声明。
