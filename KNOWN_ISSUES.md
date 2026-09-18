# Known issues — v0.5.6

- **H.264 compatibility:** some devices/ROMs close the scrcpy video socket during startup. Android Link falls back to MJPEG.
- **Direct touch compatibility:** some devices close the standalone scrcpy control socket. Android Link falls back to Appium gestures.
- **Fallback drag behavior:** Appium compatibility mode executes drag/swipe after pointer release rather than providing fully real-time pointer following.
- **Vendor ROM differences:** system-panel commands, automation permissions and background behavior vary by manufacturer.
- **Unsigned/notarization UX:** the current lightweight macOS distribution is not an App Store/notarized commercial application, so macOS may show additional security prompts.

When reporting compatibility issues, attach a redacted diagnostic export and include the macOS version, Android version and device model. Do not include raw ADB serials or private screenshots.
