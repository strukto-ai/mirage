---
name: slack
description: Acts on Slack channels, DMs and messages from inside a Mirage workspace by dispatching the `slack` CLI (a typed program tree, not a mount path). Use it whenever a task needs to send a message, reply in a thread, react, pin, or look up a member after discovering channel, DM, or user identifiers on a Mirage Slack mount such as /slack, since the mount itself is read-only.
compatibility: Requires a Mirage workspace with the `slack` CLI installed; the matching Slack mount is optional but recommended for discovering identifiers.
metadata:
  service: Slack
  mirage-tier: account-cli
---

# slack

`slack` is Mirage's Slack Web API client, installed as a typed program tree
beside a Slack mount. It is dispatched by name inside the Mirage shell (an
account CLI, not a mount path), with kebab-case verbs (`send-message`,
`read-messages`, `pin-message`). Run `slack --help` or `man slack` to print every verb and
flag.

## Find identifiers on the mount

The mount (`/slack`, the mount path your workspace uses) renders every id in
a directory or file name; `ls` the parent directory to see the exact
sanitized name before using it.

```bash
ls /slack/channels/                              # <channel-name>__<channel-id>/
ls /slack/dms/                                   # <user-name>__<dm-id>/
ls /slack/users/                                  # <username>__<user-id>.json
cat /slack/channels/general__C0000000001/2026-08-11/chat.jsonl | jq -r '.ts, .user'
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
