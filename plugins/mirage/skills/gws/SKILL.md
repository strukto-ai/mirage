---
name: gws
description: 'Use when working with Google Workspace through the `gws` CLI: Gmail, Drive, Docs, Sheets, Slides, Calendar, Forms and raw API calls.'
compatibility: Requires a Mirage workspace with the `gws` CLI installed, including under an alias. Mounts are optional and configured independently.
metadata:
  service: Google Workspace
  mirage-tier: account-cli
---

# gws

`gws` is Mirage's Google Workspace API client, installed as a typed program
tree independently of the Google mounts. It is dispatched by name inside the Mirage
shell (an account CLI, not a mount path), mirroring the official Google
Workspace CLI: one passthrough leaf per Discovery method
(`gws <service> <resource> <method>`) plus hand-written helper verbs under
each service (`gws gmail send`). Run `gws --help` for the service list,
`gws <service> <resource> --help` for that resource's methods.

## Choose the account and mount

Use Installed CLIs, or run bare `man` in the Mirage shell and read its
`# clis` section when the prompt is unavailable, to select the installation for the intended Google Workspace
account. Examples below use `gws`; substitute the installed name when
using an alias. A CLI and a mount are configured independently: neither a
shared service name nor similar paths establishes that they use the same
account. Before reusing mount IDs or human keys, confirm that association
from the workspace configuration or the user. If it is unknown, discover
IDs through the selected CLI's read commands or clarify the account first.

Set `GMAIL_MOUNT`, `GSHEETS_MOUNT` and `GCAL_MOUNT` to the confirmed mount prefixes before
running the discovery examples. Use `ls` to get the exact sanitized names.

```bash
: "${GMAIL_MOUNT:?Set GMAIL_MOUNT to the confirmed mount prefix}"
: "${GSHEETS_MOUNT:?Set GSHEETS_MOUNT to the confirmed mount prefix}"
: "${GCAL_MOUNT:?Set GCAL_MOUNT to the confirmed mount prefix}"
ls "$GMAIL_MOUNT/INBOX/2026-05-03/"                 # <subject>__<message-id>.gmail.json
ls "$GSHEETS_MOUNT/owned/"                          # <date>_<title>__<spreadsheet-id>.gsheet.json
cat "$GSHEETS_MOUNT/owned/2026-05-01_Q3_Plan__sheet0001.gsheet.json" | jq -r '.spreadsheetId'
ls "$GCAL_MOUNT/primary/2026-08-11/"                # <eventId>__<HHMM-HHMM>_<title>.gcal.json
```

For Gmail, Sheets and Docs, the id follows the last `__`; remove the
`.gmail.json`, `.gsheet.json` or `.gdoc.json` suffix first. Calendar event
filenames instead start with the event id, **before the first `__`**;
`cat` the event and read `.id` to get it directly. The primary calendar id
is `primary`; other calendar directories end in `__<calendarId>`.
Gmail's `--id`/`--message-id`, Sheets' `--spreadsheet`, Docs' `--document`,
and a passthrough's `--params '{"fileId": ...}'` or
`'{"calendarId": ..., "eventId": ...}'` take these ids, not human titles.

## Common lines

```bash
gws gmail triage --query "is:unread" --max 10
gws gmail read --id msg0005
gws gmail send --to "user@example.com" --subject "Ship update" --body "Departing Tuesday"
gws sheets read --spreadsheet sheet0001 --range "Sheet1!A1:C10"
gws sheets append --spreadsheet sheet0001 --range Sheet1 --values "alice,42"
gws docs write --document doc0001 --text "New paragraph"
```

## Pitfalls

- List methods follow `nextPageToken` to the end by default; pass
  `--page-limit N` to stop early, and expect NDJSON (one page per line)
  when several pages ran.
- `--params` carries path and query parameters as one JSON object
  (`'{"fileId": "..."}'`), `--json` is the request body; there is no plain
  flag for an individual API parameter on a passthrough leaf.
- A folder-scoped install (`folder_id`) only changes where a **create**
  lands; reads like `drive files list` still see the whole account, so the
  scope is not an access fence.
- `"...\n..."` in a double-quoted bash string is the literal characters
  backslash-n, not a newline; use `$'line1\nline2'` (ANSI-C quoting) for a
  real newline in `--body`/`--text`, or send it through `--json`.
- The hand-written helpers (`gmail send`/`reply`/`reply-all`/`forward`,
  `sheets read`/`write`/`append`, `docs write`) cover the common case; a
  need outside them (labels, calendar, forms, permissions) goes through the
  raw passthrough leaves instead.

## Reach the raw API

```bash
gws drive files list --params '{"pageSize": 10}'
gws drive permissions create --params '{"fileId": "doc0001"}' --json '{"role": "reader", "type": "anyone"}'
gws calendar events insert --params '{"calendarId": "primary"}' --json '{"summary": "Sync", "start": {"dateTime": "2026-09-10T09:00:00-07:00"}, "end": {"dateTime": "2026-09-10T09:30:00-07:00"}}'
gws gmail users messages list --params '{"userId": "me", "q": "is:unread"}'
gws forms forms create --json '{"info": {"title": "Feedback"}}'
```
