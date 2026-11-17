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

- A named segment is \`<sanitized-name>__<id>\`; the id after the last \`__\`
  is exact. \`ls\` the parent for exact names rather than building them.
- Files are JSON normalized by Mirage with snake_case keys (\`issue_key\`,
  \`state_name\`, \`assignee_email\`, \`label_names\`), not Linear's GraphQL
  shape. \`comments.jsonl\` holds one comment per line.
- \`team.json\` lists the team's workflow states; a project file lists its
  issues with their state.
- To create, update, assign, transition or comment on issues, use the
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
