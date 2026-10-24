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

import { BaseVFS } from '../base.ts'
import { GmailAccessor } from '../../accessor/gmail.ts'

import { TokenManager } from '../../core/google/client.ts'
import { VFSName } from '../../types.ts'

import { redactGmailConfig, type GmailConfig, type GmailConfigRedacted } from './config.ts'
import type { DirListing, PathSpec, FileStat } from '../../types.ts'
import type { Handed } from '../types.ts'
import { readdir as gmailReaddir } from '../../core/gmail/readdir.ts'
import { buildDeltaHook } from '../../core/gmail/events.ts'
import type { DeltaHook } from '../../events/base.ts'
import { filesContaining as gmailFilesContaining } from '../../core/gmail/search.ts'
import { read as gmailRead } from '../../core/gmail/read.ts'
import { stat as gmailStat } from '../../core/gmail/stat.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  <label>/
    <yyyy-mm-dd>/
      <subject>__<message-id>.gmail.json    # email JSON file (the email itself)
      <subject>__<message-id>/              # attachments dir, only if any
        <attachment-filename>

  Email body is in the .gmail.json file. The sibling dir holds attachments
  only. Read with \`cat\`/\`head\`/\`jq\` on \`<path>.gmail.json\` (keep the suffix).

  Path: <label>/<yyyy-mm-dd>/<subject>__<message-id>.gmail.json
    <label>       Gmail label (INBOX, SENT, DRAFT, IMPORTANT, STARRED,
                  TRASH, SPAM, or any user label)
    <yyyy-mm-dd>  date the message was received, used for date narrowing
                  (ls {prefix}/INBOX/2026-05-03/ pushes after:/before: into the
                  Gmail query - much cheaper than scanning the whole label)
    <subject>     sanitized subject (don't construct it; ls the date dir)
    <message-id>  Gmail message ID

  email JSON structure (mirage-processed, NOT the raw Gmail API response):
    {
      "id": "...",
      "thread_id": "...",
      "from":    { "name": "...", "email": "..." },
      "to":      [ { "name": "...", "email": "..." } ],
      "cc":      [ ... ],
      "subject": "...",
      "date":    "Mon, 3 May 2026 10:00:00 -0700",
      "body_text": "decoded plain-text body",
      "snippet":   "first ~200 chars from Gmail",
      "labels":  [ "INBOX", "IMPORTANT", ... ],
      "attachments": [
        { "id": "...", "filename": "invoice.pdf",
          "mime_type": "application/pdf", "size": 12345 }
      ]
    }

  Attachments: each message with attachments has a sibling directory at
  <subject>__<message-id>/ (same name as the .gmail.json file but without
  the extension). Cat a file inside to download bytes. grep -r over a
  date dir skips these binary files automatically.

  After a grep/rg hit, the result line points to .../<subject>__<id>.gmail.json
  — the sibling attachments dir is NOT in grep output. Once you have the
  message id (or the .gmail.json path), ls the same path with .gmail.json
  stripped to list attachments directly:
    ls {prefix}/INBOX/2026-05-03/<subject>__<message-id>/
  ENOENT means the message has no attachments.

  Useful jq paths:
    .subject
    .from.email
    .body_text
    .labels[]
    .attachments[] | .filename

  To act on messages (read by id, triage, raw API calls), use the gws
  CLI if installed: gws gmail --help`

export interface GmailVFSState {
  type: string
  config: GmailConfigRedacted
}

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
  override readonly searchable: readonly string[] = ['*/*/*.gmail.json']
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    stat: ['entry', 'parent'],
  } as const
  readonly config: GmailConfig
  override readonly accessor: GmailAccessor

  override readonly walkLimit: number

  constructor(config: GmailConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    const tm = new TokenManager(config)
    this.accessor = new GmailAccessor({ tokenManager: tm, config })
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

  /**
   * Whether this VFS answers `name`; with no walk limit it reads every
   * file rather than ask the service's search.
   */
  override supports(name: string): boolean {
    if (name === 'files_containing' && this.walkLimit < 0) return false
    return super.supports(name)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    _opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (this.walkLimit < 0) return Promise.resolve(null)
    return gmailFilesContaining(this.accessor, text, [path])
  }

  override getState(): Promise<GmailVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGmailConfig(this.config),
    })
  }
}
