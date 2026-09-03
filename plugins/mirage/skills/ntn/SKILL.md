---
name: ntn
description: Acts on Notion pages, databases and data sources from inside a Mirage workspace by dispatching the `ntn` CLI (a typed program tree matching the official Notion CLI grammar, not a mount path). Use it whenever a task needs to read, create, edit or trash a Notion page, query a database's rows, or call the raw Notion API after discovering page, database and data-source identifiers on a Mirage Notion mount such as /notion.
compatibility: Requires a Mirage workspace with the `ntn` CLI installed; the matching Notion mount is optional but recommended for discovering identifiers.
metadata:
  service: Notion
  mirage-tier: account-cli
---

# ntn

`ntn` is Mirage's Notion API client, installed as a typed program tree
beside a Notion mount. It is dispatched by name inside the Mirage shell (an
account CLI, not a mount path), matching the grammar of the official Notion
CLI verb for verb, including its clap-style help and refusal wording. Run
`ntn --help` or `man ntn` to print every verb and flag.

## Find identifiers on the mount

The mount (`/notion`, the mount path your workspace uses) nests a database
as a container plus one or more data sources, since Notion's `2025-09-03`
API split a database's column schema and rows off the container onto the
data source. `ls` each level to read
the exact sanitized name before using it.

```bash
ls /notion/pages/            # <title>__<page-id>/
ls /notion/databases/        # <title>__<database-id>/
ls /notion/databases/Tasks__eeee1111-2222-3333-4444-555566667777/            # <ds-title>__<data-source-id>/
ls /notion/databases/Tasks__eeee1111-2222-3333-4444-555566667777/Tasks__d5000000-2222-3333-4444-555566667777/  # row pages
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
