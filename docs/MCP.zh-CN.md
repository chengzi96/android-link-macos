# MCP 与 AI 接入

Android Link 安装后会提供本地 **stdio MCP Server**：

```text
~/Library/Application Support/AndroidLink/bin/android-link-mcp
```

MCP 不会重新创建第二个 Appium Session。它通过本机 Unix Domain Socket 连接 Android Link 的 AutomationService，复用助手当前已经建立好的真机 Session。

## 通用 JSON 配置

```json
{
  "mcpServers": {
    "android-link": {
      "command": "/bin/zsh",
      "args": [
        "-f",
        "-c",
        "exec \"$HOME/Library/Application Support/AndroidLink/bin/android-link-mcp\""
      ]
    }
  }
}
```

## Codex TOML 配置

```toml
[mcp_servers.android-link]
command = "/bin/zsh"
args = [
  "-f",
  "-c",
  "exec \"$HOME/Library/Application Support/AndroidLink/bin/android-link-mcp\""
]
enabled = true
```

这里使用 `-f`，是为了避免用户自己的 zsh 启动文件向 stdout 输出内容，污染 MCP stdio 协议。

## 推荐的 AI 调用流程

1. 读取当前手机状态。
2. 观察当前截图 / UI Tree。
3. 查找目标元素。
4. 获取控制租约。
5. 执行点击、滑动、拖拽、输入或系统按键。
6. 等待预期页面状态出现。
7. 再次观察或保存 checkpoint。
8. 释放控制租约。

浏览器人工控制和 AI 写操作共用同一套控制租约，避免双方同时抢控手机。

## 安全说明

不要把 Android Link 的运行时 Secret 写进 MCP 配置。MCP 启动器会在运行时读取本机受权限保护的 Secret 文件。公开日志或 Issue 时，也不要上传真实设备序列号、包含隐私的截图或 UI Tree。
