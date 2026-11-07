# Workspace logs contract

Both servers expose `GET /v1/workspaces/{workspace_id}/logs`. The daemon and
Cloud have different storage models and response shapes. Clients must choose
the contract for the server they address. Neither server exposes the former
`/history` management route. The shell `history` builtin, `/.bash_history`,
and the workspace library's history interface are unchanged.
The verbose workspace detail's `history_length` counts shell history commands;
it is not a count of log records and retains its name. The management clients
send generic HTTP requests and have no dedicated history method to rename.

## Daemon

The daemon accepts `session_id` (string), `since` (nonnegative Unix epoch
milliseconds, inclusive), `last` (nonnegative record count), `vfs` (boolean,
default false), and `format` (`json` or `jsonl`, default `json`). Filters
apply to individual records before `last`; the result contains at most the
recorder's history limit and is ordered oldest first. `last=0` returns no
records. There is no cursor pagination. A command and its result can be
separated by a filter or limit.

The JSON response is an array. Each record has `type`, `session`, and
`timestamp` in Unix milliseconds; `cwd` is present when known. A `command`
record has `id` and `command`. A `result` has `parent`, `duration_ms`,
`exit_code`, `stdout`, and `stderr` when recorded. A `vfs` record has
`parent`, `vfs`, `path`, `source`, `bytes`, and `duration_ms` when recorded.
Optional values may be absent. Children identify their command by `parent`.
For example:

```json
[{"type":"command","session":"s1","timestamp":1700000000000,"id":"c1","command":"echo hi"},{"type":"result","session":"s1","timestamp":1700000000008,"parent":"c1","duration_ms":8,"exit_code":0,"stdout":"hi\n","stderr":""}]
```

`format=jsonl` returns the same filtered records in the same order, one JSON
object per line with a trailing newline, as `application/x-ndjson`. An empty
export has an empty body. It is downloadable as `logs.jsonl`.

```jsonl
{"type":"command","session":"s1","timestamp":1700000000000,"id":"c1","command":"echo hi"}
{"type":"result","session":"s1","timestamp":1700000000008,"parent":"c1","duration_ms":8,"exit_code":0,"stdout":"hi\n","stderr":""}
```

The response is `200` on success, `404` for an unavailable workspace, `401`
for failed authentication, and `429` when rate limited. Invalid query values
return `422` on Python and `400` on TypeScript. These existing validation
status differences remain explicit. The endpoint preserves the existing
record filters, ordering, retention bound, and JSON payload; the route name
and JSONL export change.

## Cloud

Cloud accepts `session` (1–64 letters, digits, `.`, `_`, or `-`; an empty
value selects all sessions), `limit` (1–200, default 50), `after` (opaque
cursor), and `format` (`jsonl` requests export; otherwise JSON). JSON returns
`{items, next}`, newest first by command start time and ID. `next` is null on
the final page; pass a non-null value as `after` with the same session filter.
The retention window limits both formats. A JSON item contains `id`,
`command`, nullable `cwd`, `started_at` in Unix seconds, `duration_ms`,
nullable `exit_code`, `stdout`, `stderr`, nullable `user_id`, nullable
`api_key_id`, and `mounts`. Each mount has `op`, `path`, `source`, nullable
`bytes`, `started_at` in Unix seconds, and `duration_ms`. For example:

```json
{"items":[{"id":"c1","command":"echo hi","cwd":"/","started_at":1700000000,"duration_ms":8,"exit_code":0,"stdout":"hi\n","stderr":"","user_id":null,"api_key_id":null,"mounts":[]}],"next":null}
```

`format=jsonl` downloads all retained matching commands oldest first, ignoring
`limit` and `after`, as `application/x-ndjson` with a workspace-named
`-logs.jsonl` attachment. Each command is followed by its VFS records and
result. Their `timestamp` values are Unix milliseconds and children link to
the command through `parent`. Empty exports have an empty body. Invalid
session, limit, or cursor returns `400`; authentication, workspace access,
and rate limits can return `401`, `403`, `404`, or `429` respectively.

## Management CLI

`mirage workspace logs ID [--session S] [--since MS] [--last N] [--vfs]`
queries the daemon contract, mapping `--session` to `session_id`. The
existing management CLI addresses the daemon, not the Cloud contract. On a
terminal it prints an oldest-first table with `TIME` (UTC), `SESSION`, `TYPE`,
`EXIT`, and `ENTRY`; newlines in entry text are escaped and long entries are
truncated. An empty terminal result says `No logs.` When stdout is not a
terminal it prints the unmodified JSON array. The CLI retains its existing
flags and output behavior apart from the command and empty-message names.
For JSONL export, use the HTTP endpoint. `workspace history` is removed.
