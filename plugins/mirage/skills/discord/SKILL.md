---
name: discord
description: Acts on Discord guilds, channels and messages from inside a Mirage workspace by dispatching the `discord` CLI (a typed program tree, not a mount path). Use it whenever a task needs to send a message, reply, react, edit or delete a message, create a thread, post a poll, or look up guild members after discovering guild, channel and message identifiers on a Mirage Discord mount such as /discord.
compatibility: Requires a Mirage workspace with the `discord` CLI installed; the matching Discord mount is optional but recommended for discovering identifiers.
metadata:
  service: Discord
  mirage-tier: account-cli
---

# discord

`discord` is Mirage's Discord REST API client, installed as a typed program
tree beside a Discord mount. It is dispatched by name inside the Mirage
shell (an account CLI, not a mount path), with bare verbs (`send`, `read`,
`edit`, `delete`, `react`).
Run `discord --help` or `man discord` to print every verb and flag.

## Find identifiers on the mount

The mount (`/discord`, the mount path your workspace uses) renders every id
in a directory name; `ls` the parent directory to see the exact sanitized
name before using it.

```bash
ls /discord/                                                   # <guild-name>__<guild-id>/
ls /discord/MyServer__1256522563555819574/channels/            # <channel-name>__<channel-id>/
ls /discord/MyServer__1256522563555819574/members/             # <username>__<user-id>.json
cat /discord/MyServer__1256522563555819574/channels/general__1256522563555819574/2026-08-11/chat.jsonl \
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
