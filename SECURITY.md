# Security

## Local attack surface

Android Link is designed to keep its control plane local to the current Mac user:

- The browser control server binds to `127.0.0.1`.
- AI IPC uses a Unix Domain Socket under the user's Android Link application-data directory.
- Runtime secrets and socket files use restrictive local permissions.
- Browser requests require a randomly generated control token.
- The service validates local Host/Origin expectations and applies request-size limits and a Content Security Policy.

## Sensitive data

Treat device serials, screenshots, UI trees, typed text, authentication screens and exported logs as potentially sensitive.

Diagnostic exports are designed to exclude screenshots, UI trees, typed text, control-page tokens and raw ADB serial numbers, but users should still review files before posting them publicly.

## Reporting a vulnerability

Please open a minimal GitHub issue that does not contain secrets or personal data. If reproduction requires sensitive information, first describe the class of issue without attaching the sensitive material.
