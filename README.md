# Android Link for macOS

[简体中文](./README.zh-CN.md)

Android Link is a lightweight macOS helper for connecting to and controlling a real Android device from a local browser. It also exposes the same device session through **MCP** and a CLI, so AI clients can inspect and operate the phone without starting a second Appium session.

> Public version: **v0.5.6** · macOS 12+ · Apple Silicon and Intel

**Want to try it first?** Download the ready-to-install ZIP from [GitHub Releases](../../releases/latest). The release also includes a cleaned source ZIP.

## Why this project exists

Most Android automation stacks solve either human control or automation. Android Link is designed around a shared-session model: a person can operate the phone from the browser, while an AI client can reuse the same Android control session through MCP.

```text
Human → Browser ─┐
                 ├→ Android Link → Appium / ADB → Android device
AI → MCP / CLI ──┘
```

This avoids creating competing Appium sessions for the same device.

## Features

- USB Android device discovery through ADB
- Local browser-based phone preview and control
- Tap, drag, four-direction swipe, text input, Back, Home and Recent Apps
- Open Notifications, Quick Settings and collapse the system panel
- Screenshot capture and device-native screen recording
- Android UI hierarchy / UI Tree access for automation
- H.264 preview with automatic MJPEG fallback
- Appium gesture fallback when direct scrcpy touch is unavailable
- Live diagnostics for ADB, session, video and touch state
- Privacy-filtered diagnostic export
- Local stdio **MCP server** for Codex, Cursor and other MCP-capable AI clients
- CLI and MCP share the assistant's existing device session

## Requirements

- macOS 12 or later
- Apple Silicon (`arm64`) or Intel (`x64`)
- Android 8 / API 26 or later
- USB debugging enabled on the Android device
- A data-capable USB cable

The assistant downloads and uses private local runtimes where possible instead of replacing your system Node, Java or ADB setup.

## Quick start

### 1. Build the install package

Clone or download this repository, then run on macOS:

```bash
./scripts/build-release.sh
```

The generated package is placed in `dist/`.

### 2. Install

Unzip the generated package and double-click:

```text
安装安卓连接助手.command
```

The installer creates/replaces:

```text
~/Applications/安卓连接助手.app
```

### 3. Connect a phone

1. Enable **Developer options → USB debugging** on the Android device.
2. Connect the phone to the Mac using USB.
3. Accept the USB debugging authorization prompt on the phone.
4. Open `安卓连接助手.app`.
5. The assistant opens its control page in your default browser.
6. Select the detected Android device and connect.

The browser control service listens on **127.0.0.1 only**.

## AI / MCP integration

Android Link contains a local stdio MCP server. In the browser UI, open **AI 接入** to:

- detect supported local AI clients;
- connect supported clients without replacing unrelated MCP configuration;
- copy generic JSON, TOML or command-based MCP configuration;
- run an independent MCP health check.

Once connected, an AI client can use tools for observing the device, reading the UI tree, tapping, swiping, dragging, typing, taking screenshots and controlling Android system panels.

Example request to an AI client:

> Inspect the currently connected Android phone, open Quick Settings, capture the current state, then collapse the system panel.

See [MCP and AI integration](./docs/MCP.md).

## Safety and privacy

Android Link is intentionally local-first:

- HTTP control binds to `127.0.0.1`, not the LAN.
- AI IPC uses a Unix Domain Socket under the current user's local application data.
- IPC secrets are generated at runtime and stored with restrictive file permissions.
- Device serials, typed text and control-page tokens are treated as sensitive runtime values.
- Exported diagnostics are designed to omit screenshots, UI trees, typed content, control tokens and raw ADB serial numbers.
- The public source tree does not contain private account credentials, private project identifiers, personal paths or real device identifiers.

See [SECURITY.md](./SECURITY.md).

## Known limitations

v0.5.6 is usable but still experimental on some device/ROM combinations:

- H.264 may fail and fall back to MJPEG.
- Direct scrcpy touch may fail and fall back to Appium gestures.
- Appium fallback drag is executed after pointer release rather than fully real-time.
- Android vendor ROM behavior can vary, especially around system panels and automation permissions.
- The macOS app is a lightweight local launcher and is not an App Store/notarized commercial distribution.

See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md).

## Development

The repository has no third-party npm dependency for its unit tests.

```bash
npm test
```

The release builder assembles the macOS `.app` bundle from `src/` and `packaging/`, then creates the lightweight install package.

## Contributing

Bug reports, device/ROM compatibility results, fixes and pull requests are welcome. Please avoid including raw ADB serials, screenshots containing private information or authentication data in public issues.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT License. You may use, modify, redistribute and build derivative works, including commercial works, as long as the license and copyright notice are retained.
