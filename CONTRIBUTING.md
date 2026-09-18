# Contributing

Contributions are welcome.

Before opening a pull request:

1. Keep the local-only security boundary intact unless the change explicitly documents a new network model.
2. Do not commit credentials, raw ADB serials, personal screenshots, account data or runtime tokens.
3. Run `npm test`.
4. Describe device/ROM-specific behavior when changing streaming or input code.
5. Keep browser control, MCP and CLI on the shared-session architecture instead of silently creating a second Appium session.

For bug reports, include reproduction steps and a redacted diagnostic export when possible.
