# paperclip-plugin-ntfy

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that sends a
minimal [ntfy](https://ntfy.sh) push when a decision is waiting for a person.
It reacts to host events in real time. It does not poll.

On a stock Paperclip host today, it notifies for **new approvals** and for
**issues blocked on a human-owned unblock step**. Other triggers are built in
but wait for host events that stock Paperclip does not deliver yet. See
[Triggers and host support](#triggers-and-host-support).

## What a push contains

Every push has the same fixed shape:

```
Title: Paperclip decision <ISSUE-KEY>
Tags:  paperclip
Click: <link into the Paperclip UI>

A decision is waiting: <ISSUE-KEY>
```

`<ISSUE-KEY>` is the canonical issue identifier, such as `ABC-12`. Nothing
else is sent: no issue titles, question or approval text, labels, agent or
user names, or other details, in the body, the headers or the logs.

- **No readable issue key.** When the decision has no linked issue, or the
  plugin may not read the linked issue, the title is exactly
  `Paperclip decision`. The body is `A decision is waiting: approval` or
  `A decision is waiting: decision` when no issue is linked, and
  `A decision is waiting` when the linked issue is not readable.
- **Click link.** `<paperclipBaseUrl>/<PREFIX>/issues/<ISSUE-KEY>`. Without a
  readable key it uses the issue UUID, then the approval page. A board
  decision opens `<paperclipBaseUrl>/<PREFIX>/decisions?decisionId=<id>`.
- **Headers.** `Authorization: Bearer <token>` is added only when a token
  secret is configured, and `Priority` only when a priority is configured.

## Triggers and host support

The plugin subscribes to each event name once. Some trigger events are not
in the host's plugin event registry (`PLUGIN_EVENT_TYPES` in
`@paperclipai/shared`), so a stock host never delivers them. The plugin
subscribes to them anyway: the subscription is harmless, and the trigger
starts to work when a host emits the event.

| Category | Host event | Notifies when | Stock Paperclip host today |
|---|---|---|---|
| Approvals | `approval.created` | A new approval is created. Once the host emits them, a tool-gateway approval and its approval card count as one decision. | **Works** for the approvals the host logs as `approval.created`, such as approvals created through the approvals API, agent hire requests and invitations. Tool-gateway and budget approvals do not log `approval.created` today, so they do not notify. |
| Blocked issue with a human-owned unblock step | `issue.updated` | The issue moves into `blocked`, or its unblock descriptor changes, and its current `unblockDescriptor.owner` is `"board"` or a user. | **Works.** The plugin reads the issue to confirm the owner. |
| Interactions addressed to a person (question cards) | `issue.thread_interaction_created` | A pending interaction card with no agent addressee, which is what the board inbox shows. | **Not delivered.** The event is not in `PLUGIN_EVENT_TYPES`. Open upstream pull request [paperclipai/paperclip#4990](https://github.com/paperclipai/paperclip/pull/4990) (by another contributor, not merged) registers it. You can apply that change to your own host at your own risk; this trigger then works without changes to the plugin. |
| Board decisions | `decision.created` | An agent opens a board decision. | **Not delivered.** The event is not in `PLUGIN_EVENT_TYPES`, and no upstream change registers it yet. Forward-compatible only. |
| Computed blocker attention (stalled blocker tree) | `issue.blocker_attention_changed` | A blocked tree whose terminal blocker has no live path enters the board attention feed. | **Not delivered.** No upstream host emits this event yet. Forward-compatible only. |

The plugin also accepts an `activity.logged` plugin event whose `action` is
`issue.thread_interaction_created`, in case a host forwards activity rows to
plugins. Stock hosts do not do this today.

### Who an interaction is for

- A card whose payload names an agent addressee never notifies. That is
  agent-to-agent traffic.
- A card whose payload has an explicit empty `addresseeAgentId` is for a
  person and notifies.
- A card whose payload has no `addresseeAgentId` key at all is **never**
  treated as addressed to a person. The plugin reads the card through
  `issue.interactions.read`. If it still cannot tell (for example a private
  issue), it sends nothing and logs `addressee_unknown`.
- Resolved cards never notify.

Other events, such as comments, status changes, resolutions and decided
approvals, are ignored. Agent-owned blockers are ignored.

## Install

The plugin is not published to npm. Install it from the release tarball as a
local directory on the machine that runs the Paperclip server. You need
instance-admin access and the `paperclipai` CLI connected to that instance.

1. Download `paperclip-plugin-ntfy-<version>.tgz` and its `.sha256` file from
   the [GitHub releases](https://github.com/LiterallyBlah/paperclip-plugin-ntfy/releases),
   and check the checksum:

   ```sh
   sha256sum -c paperclip-plugin-ntfy-<version>.tgz.sha256
   ```

2. Extract it into a directory that the Paperclip server can read and that
   you will keep. The host loads the plugin from this directory; it does not
   copy it.

   ```sh
   mkdir -p ~/paperclip-plugins/ntfy
   tar -xzf paperclip-plugin-ntfy-<version>.tgz -C ~/paperclip-plugins/ntfy
   ```

   The tarball contains a `package/` directory with the bundled plugin. It has
   no runtime dependencies, so no `npm install` is needed.

3. Install it by local path:

   ```sh
   paperclipai plugin install ~/paperclip-plugins/ntfy/package
   ```

   The CLI treats an argument that starts with `/`, `./`, `../` or `~` as a
   local path (or pass `--local`). The server requires an existing directory:
   it does not accept a `.tgz` file or a URL. The plugin ID is
   `paperclip.ntfy-notifier`. The install loads the plugin straight away; no
   separate enable step is needed. `paperclipai plugin list` shows it as
   `ready`. The CLI also prints a hint to keep `pnpm dev` running in the
   plugin directory; that is for plugin development and does not apply to
   the release tarball.

   The **Install Plugin** dialog in **Settings → Plugins** installs npm
   packages only, so use the CLI for this plugin.

4. Configure it for each company: in **Settings → Plugins**, open
   **ntfy Decision Notifier** and save its configuration (see below). Until a
   company has a valid configuration, the plugin sends nothing for that
   company.

## Configuration

Configuration is per company and is validated strictly: unknown keys are
rejected.

| Key | Required | Description |
|---|---|---|
| `ntfyBaseUrl` | yes | ntfy server base URL, `https://...`. No credentials, query or fragment. |
| `topic` | yes | ntfy topic: 1-64 letters, digits, `_` or `-`. |
| `tokenSecretRef` | no | `{ "type": "secret_ref", "secretId": "<uuid>" }` for a Paperclip secret holding an ntfy access token with publish permission. The token is resolved for each send and never stored or logged. Omit it for an open topic. |
| `paperclipBaseUrl` | yes | Paperclip UI URL, used only to build the click link. |
| `priority` | no | ntfy priority, an integer from 1 to 5. |
| `triggers` | no | `{ "approvals": true, "interactions": true, "blockerAttention": true, "decisions": true }`. Each flag defaults to `true`. `blockerAttention` covers both blocker rows above. |
| `allowInsecureHttp` | no | Allows `http://` URLs, for testing only. Default `false`. It is rejected together with `tokenSecretRef`, so a token is never sent over plain http. |

Example:

```json
{
  "ntfyBaseUrl": "https://ntfy.example.com",
  "topic": "example-topic",
  "tokenSecretRef": { "type": "secret_ref", "secretId": "00000000-0000-0000-0000-000000000000" },
  "paperclipBaseUrl": "https://paperclip.example.com",
  "priority": 4
}
```

Anyone who can subscribe to the topic sees every push. Use a private topic
with an access token on a server you trust, or an unguessable topic name.

## Security notes

- **Token as a secret reference.** The ntfy token is stored as a Paperclip
  secret and referenced by ID (capability `secrets.read-ref`). It is resolved
  for each send and is never written to plugin state or logs.
- **https only with a token.** Both URLs must use `https` unless
  `allowInsecureHttp` is set, and that option cannot be combined with a
  token.
- **Outbound.** Requests go through the host-mediated `ctx.http.fetch`
  (capability `http.outbound`), so the host's outbound guard applies.
  Redirects are not followed. The stock host refuses plugin requests to
  loopback, private (RFC 1918), link-local and unique-local addresses, so the
  ntfy server must resolve to an address outside those ranges.
- **No polling.** The plugin only reacts to host events.
- **Minimal content.** Pushes and logs contain no issue text, names or
  secrets (see [What a push contains](#what-a-push-contains)).

## Delivery and dedupe

- **Bounded retries.** Each attempt has a 10 s timeout, and there are at most
  3 attempts with a short back-off. Network errors, 408, 429 and 5xx are
  retried. Other 4xx responses are final.
- **No retry after a timeout.** A timed-out request may still reach ntfy,
  because a host-proxied fetch can keep running after the plugin's timer
  fires. A retry could then publish the same push twice, so a timeout ends
  the send after one attempt.
- **Durable dedupe.** Dedupe is keyed on the decision identity, not on time,
  and is stored in company-scoped plugin state. The keys are
  `approval:<id>`, `interaction:<id>`, `tool-action:<id>`, `decision:<id>`
  and `blocker:<issueId>:<blockedTransitionAt>`. A computed blocker-attention
  item sends one push per feed episode. Duplicate deliveries and worker
  restarts do not send twice. Concurrent deliveries in one worker are
  collapsed.
- **At-least-once.** A decision is marked only after ntfy accepts the
  publish. A failed send is not marked, so a later delivery of the same event
  can still send it. Rare duplicates remain possible when the worker stops
  between a successful publish and the state write, when a timed-out request
  was in fact accepted and the event is delivered again later, or when a
  retry follows a network error or 5xx that ntfy had in fact accepted. A rare
  duplicate push is preferred over a lost decision.
- **Logs.** Log lines carry only coarse codes such as `kind`, `outcome`,
  `reason`, `status` and `attempts`. They never contain tokens, URLs,
  identifiers or event text.

## Capabilities

`events.subscribe`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`,
`plugin.state.write`, `issues.read`, `issue.interactions.read`,
`companies.read`.

## Building from source

Requirements: Node.js 24.11 or later, pnpm (the version in `packageManager`,
for example through Corepack), and GNU tar.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm build:artifact
```

`pnpm build:artifact` bundles the worker and the manifest, together with the
plugin SDK version pinned in `package.json` and its runtime dependencies,
into `artifact/paperclip-plugin-ntfy-<version>.tgz`, and writes its sha256 to
`artifact/paperclip-plugin-ntfy-<version>.tgz.sha256`. The tarball ships
`LICENSE` and `THIRD_PARTY_NOTICES.md` for the bundled packages.

### Reproducing the release checksum

The tarball is deterministic: sorted entries, fixed mtime and owner, and gzip
without a timestamp. To reproduce a release, check out its tag, run the
commands above on Linux with GNU tar and gzip, and compare
`artifact/*.sha256` with the `.sha256` file attached to the release. Two clean
builds of the same commit produce the same sha256, and CI checks this on
every push.

The artifact build requires GNU tar (`--sort=name`, `--mtime`, `--owner`).
It stops with an error, and writes no archive or checksum, when `tar` is not
GNU tar, when `tar` or `gzip` fails, or when the installed plugin SDK does not
match the pinned version. On macOS, install GNU tar (for example
`brew install gnu-tar`) and put its `gnubin` directory first on `PATH`.

To build for a different Paperclip host release, pin the matching SDK with
`pnpm add -E @paperclipai/plugin-sdk@<version>`, then rebuild.

## Licence

MIT. See [LICENSE](LICENSE). The release tarball bundles third-party code; see
`THIRD_PARTY_NOTICES.md` inside it.
