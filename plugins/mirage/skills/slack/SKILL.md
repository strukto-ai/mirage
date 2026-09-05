---
name: slack
description: 'Use when working with Slack through the `slack` CLI: messages, replies, reactions, pins, channels, DMs and members.'
compatibility: Requires a Mirage workspace with the `slack` CLI installed, including under an alias. Mounts are optional and configured independently.
metadata:
  service: Slack
  mirage-tier: account-cli
---

# slack

`slack` is Mirage's Slack Web API client, installed as a typed program tree
independently of Slack mounts. It is dispatched by name inside the Mirage shell (an
account CLI, not a mount path), with kebab-case verbs (`send-message`,
`read-messages`, `pin-message`). Run `slack --help` or `man slack` to print every verb and
flag.

## Choose the account and mount

Use Installed CLIs, or run bare `man` in the Mirage shell and read its
`# clis` section when the prompt is unavailable, to select the installation for the intended Slack
account. Examples below use `slack`; substitute the installed name when
using an alias. A CLI and a mount are configured independently: neither a
shared service name nor similar paths establishes that they use the same
account. Before reusing mount IDs or human keys, confirm that association
from the workspace configuration or the user. If it is unknown, discover
IDs through the selected CLI's read commands or clarify the account first.

Set `SLACK_MOUNT` to the confirmed mount prefix before
running the discovery examples. Use `ls` to get the exact sanitized names.

```bash
: "${SLACK_MOUNT:?Set SLACK_MOUNT to the confirmed mount prefix}"
ls "$SLACK_MOUNT/channels/"                              # <channel-name>__<channel-id>/
ls "$SLACK_MOUNT/dms/"                                   # <user-name>__<dm-id>/
ls "$SLACK_MOUNT/users/"                                  # <username>__<user-id>.json
cat "$SLACK_MOUNT/channels/general__C0000000001/2026-08-11/chat.jsonl" | jq -r '.ts, .user'
```

The ID is the last `__`-separated segment of the directory or file name.
`--channel` takes the channel or DM ID from that segment (there is no
name-accepting sibling flag for it, so `ls` the mount first); a message's
`ts` field from `chat.jsonl` is what `--ts`/`--thread-ts` expect.

## Common lines

```bash
slack read-messages --channel C0000000001 --limit 20
slack reactions --channel C0000000001 --ts 1712345678.123456
slack list-pins --channel C0000000001
slack member-info --user U04K21SEVR9
slack search --query 'from:@priya in:#general launch' --count 20 --page 1
slack send-message --channel C0000000001 --text "Hello from Mirage"
slack send-message --channel C0000000001 --thread-ts 1712345678.123456 --text "Thread reply"
slack react --channel C0000000001 --ts 1712345678.123456 --emoji thumbsup
```

## Pitfalls

- `--thread-ts` is a message's `ts` value (a Slack timestamp like
  `1712345678.123456`), not a human date; pull it from `chat.jsonl`.
- `--emoji` takes the name without colons (`thumbsup`, not `:thumbsup:`).
- `search` needs a Slack user token (`search_token`) configured at install
  time, separate from the bot token every other verb uses.
- The mount is read-only; sending, reacting, pinning, and unpinning all go
  through this CLI, never through a write to a mounted path.
