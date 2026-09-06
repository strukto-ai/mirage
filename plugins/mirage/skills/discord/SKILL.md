---
name: discord
description: 'Use when working with Discord through the `discord` CLI: messages, reactions, threads, polls, guilds, channels and members.'
compatibility: Requires a Mirage workspace with the `discord` CLI installed, including under an alias. Mounts are optional and configured independently.
metadata:
  service: Discord
  mirage-tier: account-cli
---

# discord

`discord` is Mirage's Discord REST API client, installed as a typed program
tree independently of Discord mounts. It is dispatched by name inside the Mirage
shell (an account CLI, not a mount path), with bare verbs (`send`, `read`,
`edit`, `delete`, `react`).
Run `discord --help` or `man discord` to print every verb and flag.

## Choose the account and mount

Use Installed CLIs, or run bare `man` in the Mirage shell and read its
`# clis` section when the prompt is unavailable, to select the installation for the intended Discord
account. Examples below use `discord`; substitute the installed name when
using an alias. A CLI and a mount are configured independently: neither a
shared service name nor similar paths establishes that they use the same
account. Before reusing mount IDs or human keys, confirm that association
from the workspace configuration or the user. If it is unknown, discover
IDs through the selected CLI's read commands or clarify the account first.

Set `DISCORD_MOUNT` to the confirmed mount prefix before
running the discovery examples. Use `ls` to get the exact sanitized names.

```bash
: "${DISCORD_MOUNT:?Set DISCORD_MOUNT to the confirmed mount prefix}"
ls "$DISCORD_MOUNT/"                                                   # <guild-name>__<guild-id>/
ls "$DISCORD_MOUNT/MyServer__1256522563555819574/channels/"            # <channel-name>__<channel-id>/
ls "$DISCORD_MOUNT/MyServer__1256522563555819574/members/"             # <username>__<user-id>.json
cat "$DISCORD_MOUNT/MyServer__1256522563555819574/channels/general__1256522563555819574/2026-08-11/chat.jsonl" \
  | jq -r '.id, .author.username'
```

IDs are Discord snowflakes, the last `__`-separated segment of a directory
name. `--guild` and `--channel` take these ids directly; a message's `id`
field from `chat.jsonl` is what `--message`/`--reply-to` expect.

## Common lines

```bash
discord read --channel 1256522563555819574 --limit 20
discord server-info --guild 1256522563555819574
discord members --guild 1256522563555819574 --query "alice"
discord search --guild 1256522563555819574 --query "deploy" --channel 1256522563555819574
discord send --channel 1256522563555819574 --text "Hello from Mirage"
discord send --channel 1256522563555819574 --text "A reply" --reply-to 1489887688978075769
discord react --channel 1256522563555819574 --message 1489887688978075769 --emoji "👍"
discord poll --channel 1256522563555819574 --question "Lunch?" --answer Pizza --answer Sushi --duration 24
```

## Pitfalls

- `--emoji` takes a Unicode emoji or a custom emoji's `name:id`, not an alias such as `thumbsup`.
- `edit` only works on messages the bot itself authored; editing someone
  else's message fails against the Discord API regardless of permissions.
- `--answer` repeats, one flag per poll option (`--answer Pizza --answer Sushi`), not a comma-separated list.
- `search` indexes message text only, not attachment content; to search
  inside a text attachment, `grep` the attachment path on the mount.
- The mount is read-only; every write (send, edit, delete, react, threads,
  polls) goes through this CLI, never through a write to a mounted path.
