# MCP and AI integration

Android Link exposes a local **stdio MCP server** at the installed path:

```text
~/Library/Application Support/AndroidLink/bin/android-link-mcp
```

The MCP server does not create a second Appium session. It talks to the Android Link AutomationService over a local Unix Domain Socket and reuses the device session already owned by the assistant.

## Generic JSON configuration

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

## Codex TOML configuration

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

`-f` prevents user shell startup files from writing unexpected stdout into the MCP stdio protocol.

## Typical AI flow

1. Read device status.
2. Observe the current screen / UI tree.
3. Find elements.
4. Acquire the control lease.
5. Tap, swipe, drag, type or press system keys.
6. Wait for the expected UI state.
7. Observe again or save a checkpoint.
8. Release the control lease.

Human browser control and AI writes are coordinated through the same control-lease system.

## Security

Do not place Android Link runtime secrets in MCP configuration. The MCP launcher reads the locally protected runtime secret at execution time. Do not share raw device serials, screenshots or UI dumps containing private information in public logs.
