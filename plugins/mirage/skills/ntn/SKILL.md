---
name: ntn
description: 'Use when working with Notion through the `ntn` CLI: pages, databases, data sources and raw API calls.'
compatibility: Requires a Mirage workspace with the `ntn` CLI installed, including under an alias. Mounts are optional and configured independently.
metadata:
  service: Notion
  mirage-tier: account-cli
---

# ntn

`ntn` is Mirage's Notion API client, installed as a typed program tree
independently of Notion mounts. It is dispatched by name inside the Mirage shell (an
account CLI, not a mount path), matching the grammar of the official Notion
CLI verb for verb, including its clap-style help and refusal wording. Run
`ntn --help` or `man ntn` to print every verb and flag.

## Choose the account and mount

Use Installed CLIs, or run bare `man` in the Mirage shell and read its
`# clis` section when the prompt is unavailable, to select the installation for the intended Notion
account. Examples below use `ntn`; substitute the installed name when
using an alias. A CLI and a mount are configured independently: neither a
shared service name nor similar paths establishes that they use the same
account. Before reusing mount IDs or human keys, confirm that association
from the workspace configuration or the user. If it is unknown, discover
IDs through the selected CLI's read commands or clarify the account first.

Set `NOTION_MOUNT` to the confirmed mount prefix before
running the discovery examples. Use `ls` to get the exact sanitized names.

Notion databases contain data sources, which hold the column schema and
row pages under the `2025-09-03` API. Inspect each directory level.

```bash
: "${NOTION_MOUNT:?Set NOTION_MOUNT to the confirmed mount prefix}"
ls "$NOTION_MOUNT/pages/"            # <title>__<page-id>/
ls "$NOTION_MOUNT/databases/"        # <title>__<database-id>/
ls "$NOTION_MOUNT/databases/Tasks__eeee1111-2222-3333-4444-555566667777/"            # <ds-title>__<data-source-id>/
ls "$NOTION_MOUNT/databases/Tasks__eeee1111-2222-3333-4444-555566667777/Tasks__d5000000-2222-3333-4444-555566667777/"  # row pages
```

**Ids are positional operands, not flags**: `ntn pages get <PAGE_ID>`, not
`ntn pages get --page <PAGE_ID>`. **A data source id is not its database
id**; they are different ids for related objects, and a row's parent is
the data source, not the database. `ntn datasources resolve <database-id>`
turns a database id into its data source ids when only the database id is
on hand; `ntn datasources query` accepts either a database id or a data
source id in the same slot, resolving a database id to its data source
first.

## Common lines

```bash
ntn whoami
ntn pages get aaaa1111-2222-3333-4444-555566667777
ntn datasources resolve eeee1111-2222-3333-4444-555566667777
ntn datasources query d5000000-2222-3333-4444-555566667777 --limit 10
ntn datasources query d5000000-2222-3333-4444-555566667777 --filter '{"property":"Stage","select":{"equals":"Done"}}'
ntn pages create --content '# Title' --parent page:aaaa1111-2222-3333-4444-555566667777
ntn pages edit aaaa1111-2222-3333-4444-555566667777 --content '## Notes'
ntn pages trash aaaa1111-2222-3333-4444-555566667777 --yes
```

## Pitfalls

- Ids are positional operands on every typed verb (`pages get`, `pages edit`, `pages trash`, `datasources query`, `datasources resolve`); there
  is no `--page`, `--block`, or `--datasource` flag anywhere in the tree.
- `--parent` takes exactly one of three prefixed forms:
  `page:<id>`, `database:<id>`, or `data-source:<id>`; forgetting the
  prefix (just the bare id) is a usage error, not a guess at intent.
- `pages trash` refuses without `--yes` unless a prompt can be answered;
  always pass `--yes` in a non-interactive Mirage shell.
- `pages create`/`pages edit` take the Markdown body on `--content` or
  from stdin, never both; `edit` replaces the page body wholesale rather
  than appending to it.
- `datasources query` prints one tab-separated line per row (page id, then
  columns in alphabetical order); it does not print a JSON array unless
  `--json` is passed.
- There is no `ntn blocks`, `ntn comments`, or `ntn search`; every one of
  those, and setting a row's own property values, goes through `ntn api`
  with the REST API's own paths, since only `pages`/`datasources` verbs are
  typed here.

## Reach the raw API

```bash
ntn api v1/users/me
ntn api v1/search -d '{"query":"Roadmap"}'
ntn api v1/pages/ffff2222-3333-4444-5555-666677778888 -X PATCH -d '{"properties":{"Stage":{"select":{"name":"Draft"}}}}'
ntn api v1/blocks/ffff1111-2222-3333-4444-555566667777 -X DELETE
ntn api v1/comments -d '{"parent":{"page_id":"aaaa1111-2222-3333-4444-555566667777"},"rich_text":[{"type":"text","text":{"content":"hi"}}]}'
```

The request body comes from exactly one source: stdin, `--data`/`-d`, or
inline `path=value`/`path:=json` arguments; naming two is an error. Any body
source makes the call a POST unless `-X` says otherwise.
