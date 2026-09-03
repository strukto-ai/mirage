---
name: gws
description: Acts on Gmail, Drive, Docs, Sheets, Slides, Calendar and Forms from inside a Mirage workspace by dispatching the `gws` CLI (a typed program tree, not a mount path). Use it whenever a task needs to send mail, edit a spreadsheet or document, or call any Google Workspace API method directly after discovering identifiers on a Mirage mount such as /gmail, /gdrive, /gsheets, /gdocs or /gcal.
compatibility: Requires a Mirage workspace with the `gws` CLI installed; the matching Google Workspace mounts (Gmail, Drive, Docs, Sheets, Slides, Calendar) are optional but recommended for discovering identifiers.
metadata:
  service: Google Workspace
  mirage-tier: account-cli
---

# gws

`gws` is Mirage's Google Workspace API client, installed as a typed program
tree beside the Google mounts. It is dispatched by name inside the Mirage
shell (an account CLI, not a mount path), mirroring the official Google
Workspace CLI: one passthrough leaf per Discovery method
(`gws <service> <resource> <method>`) plus hand-written helper verbs under
each service (`gws gmail send`). Run `gws --help` for the service list,
`gws <service> <resource> --help` for that resource's methods.

## Find identifiers on the mount

Each service's mount (the mount path your workspace uses, e.g. `/gmail`,
`/gdrive`, `/gsheets`, `/gdocs`, `/gcal`) encodes the id the CLI needs in a
file or directory name.

```bash
ls /gmail/INBOX/2026-05-03/                 # <subject>__<message-id>.gmail.json
ls /gdrive/owned/                           # <date>_<title>__<spreadsheet-id>.gsheet.json
cat /gdrive/owned/2026-05-01_Q3_Plan__sheet0001.gsheet.json | jq -r '.spreadsheetId'
ls /gcal/primary/2026-08-11/                # <eventId>__<HHMM-HHMM>_<title>.gcal.json
```

The id is the segment after the last `__`. Gmail's `--id`/`--message-id`,
Sheets' `--spreadsheet`, Docs' `--document`, and a passthrough's
`--params '{"fileId": ...}'`/`{"calendarId": ..., "eventId": ...}` all take
that id directly; there is no separate name-lookup flag, since Google's own
ids (not human titles) are what every method expects.

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
