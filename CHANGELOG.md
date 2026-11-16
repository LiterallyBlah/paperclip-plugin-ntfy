# Changelog

## 0.4.0

- New optional hold-until-triage: settings `triageAgentId` (default empty),
  `holdNonTriageItems` (default `true`) and `holdSeconds` (default `120`).
  Without `triageAgentId` behaviour is unchanged from 0.3.0.
- Items raised by the triage agent push at once; other items are held and
  pushed only if still open when the hold ends. Holds survive a restart; an
  overdue hold or a failed re-read pushes.
- New capability `approvals.read` for the approval re-read.

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
