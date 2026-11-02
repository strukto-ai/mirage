// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { LinearAccessor } from '../../accessor/linear.ts'
import { HttpLinearTransport } from '../../core/linear/client.ts'
import { LinearConfig } from '../../core/linear/config.ts'
import { read as linearRead } from '../../core/linear/read.ts'
import { readdir as linearReaddir } from '../../core/linear/readdir.ts'
import { filesContaining as linearFilesContaining } from '../../core/linear/search.ts'
import { stat as linearStat } from '../../core/linear/stat.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { type DirListing, VFSName } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'

export const VFS_MD = `\`\`\`text
{prefix}
  teams/
    <team-key>__<team-name>__<team-id>/
      team.json
      members/
        <display-name>__<user-id>.json
      issues/
        <issue-key>__<issue-id>/
          issue.json
          comments.jsonl
      projects/
        <name>__<project-id>.json
      cycles/
        <name>__<cycle-id>.json
      documents/
        <title>__<document-id>.json
\`\`\`

- \`ls\` directories first to discover exact names.
- Every entity-named segment is \`<sanitized-human-readable>__<id>\`. The
  human-readable part is sanitized, so don't construct it; \`ls\` the
  parent directory instead.
- The id is the last \`__\`-separated segment:

\`\`\`text
{prefix}/teams/STR__Strukto-ai__<team-id>/         -> <team-id>
{prefix}/teams/.../issues/STR-42__<issue-id>/      -> <issue-id>
{prefix}/teams/.../members/Alice__<user-id>.json   -> <user-id>
\`\`\`

All \`cat\` output is normalized by Mirage (snake_case keys), not the raw
Linear GraphQL response. The shapes:

\`team.json\`:

\`\`\`jsonc
{
  "team_id": "...", "team_key": "STR", "team_name": "Strukto",
  "name": "...", "description": "...", "timezone": "...",
  "updated_at": "...",
  "states": [
    { "state_id": "...", "state_name": "Todo", "type": "unstarted" },
    ...                              // one element per workflow state
  ]
}
\`\`\`

\`issue.json\`:

\`\`\`jsonc
{
  "issue_id": "...", "issue_key": "STR-42",
  "title": "...", "description": "...",
  "team_id": "...", "team_key": "...", "team_name": "...",
  "project_id": "...",   "project_name": "...",
  "cycle_id": "...",     "cycle_name": "...",   "cycle_number": 7,
  "state_id": "...",     "state_name": "In Progress",
  "assignee_id": "...",  "assignee_email": "...", "assignee_name": "...",
  "creator_id":  "...",  "creator_email":  "...", "creator_name":  "...",
  "priority": 2,         // 0=none 1=urgent 2=high 3=medium 4=low
  "label_ids":   ["..."],
  "label_names": ["bug", "frontend"],
  "created_at": "...", "updated_at": "...", "url": "..."
}
\`\`\`

\`comments.jsonl\`, one normalized comment per line:

\`\`\`jsonc
{ "comment_id": "...", "issue_id": "...", "issue_key": "STR-42",
  "user_id": "...", "user_email": "...", "user_name": "...",
  "body": "...", "created_at": "...", "updated_at": "...",
  "url": "..." }
\`\`\`

A project (\`projects/<name>__<project-id>.json\`):

\`\`\`jsonc
{
  "project_id": "...", "team_id": "...",
  "name": "...", "description": "...", "state": "started",
  "lead_id": "...", "updated_at": "...", "url": "...",
  "issue_count": 12,
  "issues": [
    { "issue_id": "...", "issue_key": "STR-42", "title": "...",
      "state_id": "...", "state_name": "In Progress", "url": "..." }
  ]
}
\`\`\`

A cycle (\`cycles/<name>__<cycle-id>.json\`):

\`\`\`jsonc
{
  "cycle_id": "...", "team_id": "...",
  "name": "...", "number": 7,
  "starts_at": "...", "ends_at": "...",
  "updated_at": "...", "url": "..."
}
\`\`\`

A member (\`members/<display-name>__<user-id>.json\`):

\`\`\`jsonc
{
  "user_id": "...", "name": "...", "display_name": "...",
  "email": "...", "is_active": true, "is_admin": false,
  "updated_at": "...", "url": "..."
}
\`\`\`

A document (\`documents/<title>__<document-id>.json\`):

\`\`\`jsonc
{
  "document_id": "...", "title": "...", "content": "...",
  "project_id": "...", "project_name": "...",
  "creator_id": "...", "creator_name": "...", "creator_email": "...",
  "created_at": "...", "updated_at": "...", "url": "..."
}
\`\`\`

Useful \`jq\` paths:

\`\`\`jq
.issue_key                                          # issue.json
.state_name                                         # issue.json
.assignee_email                                     # issue.json
.label_names[]                                      # issue.json
.issues[] | select(.state_name == "In Progress")    # a project
.states[].state_name                                # team.json
[inputs] | length                                   # comments.jsonl: count
[inputs | select(.user_email == "x")] | length      # comments.jsonl
\`\`\`

To act on issues (list, get, create, update, assign, transition,
comments, projects, cycles, labels, users, documents, search), use the
\`linear\` CLI if installed (\`linear --help\`).`

export class LinearVFS extends BaseVFS {
  override readonly handed = {
    readdir: ['entry'],
    read: ['parent'],
    stat: ['entry'],
  } as const

  override readonly name: string = VFSName.LINEAR
  override readonly cachesReads: boolean = true
  // Every file is sized at its parent's readdir from the listing payload
  // (comments.jsonl via one bounded comments call), so stat always reports
  // the rendered byte length and fskit mounts serve exact reads.
  override readonly sizesAlwaysKnown: boolean = true
  override vfsMd: string = VFS_MD
  readonly config: LinearConfig
  override readonly accessor: LinearAccessor
  // Linear's search answers for issues; comments and the team's other files
  // are always read.
  override readonly searchable: readonly string[] = [
    'teams/*/issues/*/issue.json',
    'teams/*/members/*',
    'teams/*/projects/*',
    'teams/*/cycles/*',
    'teams/*/documents/*',
  ]

  constructor(config: LinearConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string; timeout?: number } = {
      apiKey: config.apiKey,
    }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    if (config.timeout !== undefined) transportOpts.timeout = config.timeout
    const accessorOpts: { teamIds?: readonly string[]; capped: () => boolean } = {
      capped: () => this.walkLimit >= 0,
    }
    if (config.teamIds !== undefined) accessorOpts.teamIds = config.teamIds
    this.accessor = new LinearAccessor(new HttpLinearTransport(transportOpts), accessorOpts)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    return linearFilesContaining(this.accessor, text, [path], opts.wholeWord && this.walkLimit >= 0)
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return linearReaddir(this.accessor, path, handed?.entry, null, handed?.limit)
  }

  override async read(path: PathSpec, handed?: Handed): Promise<Uint8Array> {
    return linearRead(this.accessor, path, null, handed?.parent)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return linearStat(this.accessor, path, handed?.entry)
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof LinearConfig>>> {
    return Promise.resolve(this.configState(LinearConfig, this.config))
  }
}
