# Architecture

Android Link uses a local shared-session architecture:

```text
Browser UI ───────────────┐
                          ├─> Control / AutomationService ─> existing Appium session ─> Android
MCP server / CLI ─> IPC ──┘
```

Key boundaries:

- The HTTP control server binds to `127.0.0.1`.
- MCP is stdio-based and reaches the assistant through a Unix Domain Socket.
- Browser and AI control reuse one device session.
- A control lease serializes AI writes and coordinates human takeover.
- H.264 and direct-touch are optional fast paths; MJPEG and Appium gestures are compatibility fallbacks.
- Diagnostic exports are deliberately privacy-filtered.
