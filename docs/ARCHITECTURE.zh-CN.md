# 架构说明

Android Link 使用本地共享 Session 架构：

```text
浏览器 UI ───────────────┐
                         ├─> Control / AutomationService ─> 已有 Appium Session ─> Android
MCP Server / CLI ─> IPC ─┘
```

核心边界：

- HTTP 控制服务只监听 `127.0.0.1`。
- MCP 使用 stdio，并通过 Unix Domain Socket 进入助手。
- 浏览器人工控制与 AI 控制复用同一个设备 Session。
- 控制租约负责串行化 AI 写操作，并处理人工接管。
- H.264 和实时跟手触控属于高性能路径；失败时分别回退 MJPEG 与 Appium 手势。
- 诊断导出会主动做隐私脱敏。
