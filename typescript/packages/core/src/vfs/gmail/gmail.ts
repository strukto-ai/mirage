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

import { PROMPT, WRITE_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactGmailConfig, type GmailConfig, type GmailConfigRedacted } from './config.ts'
import type { DirListing, PathSpec, FileStat } from '../../types.ts'
import type { Handed } from '../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as gmailReaddir } from '../../core/gmail/readdir.ts'
import { buildDeltaHook } from '../../core/gmail/events.ts'
import type { DeltaHook } from '../../events/base.ts'
import { filesContaining as gmailFilesContaining } from '../../core/gmail/search.ts'
import { read as gmailRead } from '../../core/gmail/read.ts'
import { stat as gmailStat } from '../../core/gmail/stat.ts'
import { FULL_SCAN_LIMIT } from '../constants.ts'

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
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  // The listing keeps each message's text; an attachment is read as usual.
  override readonly searchable: readonly string[] = ['*/*/*.gmail.json']
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    stat: ['entry', 'parent'],
  } as const
  readonly config: GmailConfig
  override readonly accessor: GmailAccessor

  override readonly fullScanLimit: number

  constructor(config: GmailConfig) {
    super()
    this.config = config
    this.fullScanLimit = config.fullScanLimit ?? FULL_SCAN_LIMIT
    const tm = new TokenManager(config)
    this.accessor = new GmailAccessor({ tokenManager: tm, config })
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return gmailReaddir(this.accessor, path, handed?.entry)
  }

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gmailRead(this.accessor, path, handed?.entry)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
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
    if (this.fullScanLimit < 0) return Promise.resolve(null)
    return gmailFilesContaining(this.accessor, text, [path])
  }

  override getState(): Promise<GmailVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGmailConfig(this.config),
    })
  }
}
