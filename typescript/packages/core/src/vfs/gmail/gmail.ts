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

import { GmailAccessor } from '../../accessor/gmail.ts'
import { buildDeltaHook } from '../../core/gmail/events.ts'
import { read as gmailRead } from '../../core/gmail/read.ts'
import { readdir as gmailReaddir } from '../../core/gmail/readdir.ts'
import { filesContaining as gmailFilesContaining } from '../../core/gmail/search.ts'
import { stat as gmailStat } from '../../core/gmail/stat.ts'
import { TokenManager } from '../../core/google/client.ts'
import type { DeltaHook } from '../../events/base.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import { VFSName } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'
import { GmailConfig } from './config.ts'

export const VFS_MD = `\`\`\`text
{prefix}
  <label>/
    <yyyy-mm-dd>/
      <subject>__<message-id>.gmail.json   # the email, body included
      <subject>__<message-id>/             # its attachments, if any
        <attachment-filename>
\`\`\`

- \`<label>\` is a Gmail label (\`INBOX\`, \`SENT\`, \`STARRED\`, ... or a user
  label); \`<yyyy-mm-dd>\` is the received date, and listing one queries
  only that day.
- \`ls\` a date directory for the names rather than building \`<subject>\`.
- A \`.gmail.json\` is the email processed by Mirage, not the raw API
  response: \`.from\`, \`.to\`, \`.subject\`, \`.date\`, \`.body_text\`, \`.labels\`,
  \`.attachments[]\`.
- The sibling directory holds attachments only (\`cat\` one for its bytes)
  and is absent when there are none; \`grep -r\` skips its binary files.
- Triage and other changes go through the \`gws gmail\` CLI.`

export class GmailVFS extends BaseVFS {
  override readonly name: string = VFSName.GMAIL
  override readonly cachesReads: boolean = true
  // Every listed file carries an exact size: .gmail.json is rendered at
  // readdir from the full message the listing already fetched, and
  // attachments carry the decoded byte count.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  override vfsMd: string = VFS_MD
  // The listing keeps each message's text; an attachment is read as usual.
  override readonly searchNeedsWalkLimit: boolean = true
  override readonly searchable: readonly string[] = ['*/*/*.gmail.json']
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    stat: ['entry', 'parent'],
  } as const
  readonly config: GmailConfig
  override readonly accessor: GmailAccessor

  constructor(config: GmailConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GmailAccessor({
      tokenManager: tm,
      config,
      capped: () => this.walkLimit >= 0,
    })
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return gmailReaddir(this.accessor, path, handed?.entry)
  }

  override async read(path: PathSpec, handed?: Handed): Promise<Uint8Array> {
    return gmailRead(this.accessor, path, handed?.entry)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return gmailStat(this.accessor, path, handed?.entry, handed?.parent)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    _opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (this.walkLimit < 0) return Promise.resolve(null)
    return gmailFilesContaining(this.accessor, text, [path])
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof GmailConfig>>> {
    return Promise.resolve(this.configState(GmailConfig, this.config))
  }
}
