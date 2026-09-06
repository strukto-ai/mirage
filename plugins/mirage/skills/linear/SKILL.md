---
name: linear
description: 'Use when working with Linear through the `linear` CLI: issues, teams, projects, cycles, labels, comments, users and documents.'
compatibility: Requires a Mirage workspace with the `linear` CLI installed, including under an alias. Mounts are optional and configured independently.
metadata:
  service: Linear
  mirage-tier: account-cli
---

# linear

`linear` is Mirage's Linear GraphQL API client, installed as a typed program
tree independently of Linear mounts. It is dispatched by name inside the Mirage
shell (an account CLI, not a mount path), speaking a noun/verb grammar
(`linear issue create`, `linear team list`). Run `linear --help` or
`man linear` to print every verb, subcommand and flag.

## Choose the account and mount

Use Installed CLIs, or run bare `man` in the Mirage shell and read its
`# clis` section when the prompt is unavailable, to select the installation for the intended Linear
account. Examples below use `linear`; substitute the installed name when
using an alias. A CLI and a mount are configured independently: neither a
shared service name nor similar paths establishes that they use the same
account. Before reusing mount IDs or human keys, confirm that association
from the workspace configuration or the user. If it is unknown, discover
IDs through the selected CLI's read commands or clarify the account first.

Set `LINEAR_MOUNT` to the confirmed mount prefix before
running the discovery examples. Use `ls` to get the exact sanitized names.

```bash
: "${LINEAR_MOUNT:?Set LINEAR_MOUNT to the confirmed mount prefix}"
ls "$LINEAR_MOUNT/teams/"                                    # PLAT__Platform__<team-id>/
cat "$LINEAR_MOUNT/teams/PLAT__Platform__team-1/team.json" | jq -r '.states[].state_name'
ls "$LINEAR_MOUNT/teams/PLAT__Platform__team-1/issues/"       # PLAT-1__<issue-id>/
ls "$LINEAR_MOUNT/teams/PLAT__Platform__team-1/members/"      # <display-name>__<user-id>.json
ls "$LINEAR_MOUNT/teams/PLAT__Platform__team-1/projects/"     # <name>__<project-id>.json
```

IDs are the last `__`-separated segment of a directory or file name. Issues
are addressed by their human key (`PLAT-1`), which the CLI accepts directly,
so most flows never need the trailing id at all. `--team` takes a team key,
name, or ID interchangeably. Several write flags come in id/name pairs so a
name found on the mount can be used without resolving it first:
`--project`/`--project-name`, `--label`/`--label-name`,
`--state-id`/`--state-name`, `--assignee-id`/`--assignee-email`.

## Common lines

```bash
linear team list
linear team get PLAT
linear issue list --team PLAT
linear issue get PLAT-1
linear issue create --team PLAT --title "Add search API" --description "Body text"
linear issue assign PLAT-1 --assignee-email sam@example.com
linear issue transition PLAT-1 --state-name "In Review"
linear comment add PLAT-1 --body "Looks good, shipping this"
```

## Pitfalls

- Only `issue` and `comment` subcommands write; `team`, `project`, `cycle`,
  `label`, `user`, and `document` are read-only through this CLI.
- Prefer the name-accepting sibling flag (`--state-name`, `--project-name`,
  `--label-name`, `--assignee-email`) over hunting for the matching id;
  either the id or the name flag works, never both are required.
- `comment update` takes the comment's ID as a required `--comment` flag,
  not a positional, unlike `comment add` which takes the issue key
  positionally.
- `--description` and `--body` also read from stdin
  (`echo "body" | linear comment add PLAT-1`), which is the easier path
  for multi-line text.
- `--priority` is an integer 0 to 4 (0=none, 1=urgent, 2=high, 3=medium,
  4=low), not a name.
- Every command emits normalized JSON with snake_case keys (not the raw
  GraphQL response), so pipe output straight into `jq`.
