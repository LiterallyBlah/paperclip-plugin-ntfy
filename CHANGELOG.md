# Changelog

## 0.3.0

First standalone release. Notification behaviour is unchanged from the
earlier in-tree version 0.2.2.

- Published as a standalone repository with its own build, tests and CI.
- Package renamed to `paperclip-plugin-ntfy`. The plugin ID stays
  `paperclip.ntfy-notifier`, so existing installs keep their configuration.
- Builds against the published `@paperclipai/plugin-sdk` `2026.1106.0`.
- The manifest description now states which triggers a stock host delivers.
- The release tarball is reproducible and ships `LICENSE` and
  `THIRD_PARTY_NOTICES.md` for the bundled SDK and its dependencies.
