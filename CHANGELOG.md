# Changelog

## 0.4.2

Fix release. No new capability, setting or trigger.

- The access token setting (`tokenSecretRef`) is declared as a string
  secret reference. The host validates a secret reference by its secret id,
  so 0.4.1 rejected any configuration with an access token
  ("must be object") before it reached the worker. The worker still
  receives and accepts the `{ "type": "secret_ref", "secretId": ... }`
  binding.

## 0.4.1

Hardening release. No new capability, setting or trigger.

- A held push whose release fails (for example because the configuration
  could not be read) is kept and retried (30 s, doubling to at most 15 min)
  instead of being dropped.
- A release that runs outside the hold timer clears the armed timer before
  arming a new one.
- Sent markers are pruned once they have not been touched for 30 days. A
  marker is touched on every send and on every later event for the same item,
  and a marker is kept while its item is still live (an open feed episode, or
  an issue still blocked on the same human-owned step). An instance-scope
  index (`marker-index`) tracks the markers, because plugin state cannot be
  listed. Markers written by 0.4.0 or earlier join the index the next time an
  event for their item arrives.

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
