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
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as gmailReaddir } from '../../core/gmail/readdir.ts'
import { read as gmailRead } from '../../core/gmail/read.ts'
import { stat as gmailStat } from '../../core/gmail/stat.ts'

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
  readonly config: GmailConfig
  override readonly accessor: GmailAccessor

  constructor(config: GmailConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GmailAccessor({ tokenManager: tm })
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return gmailReaddir(this.accessor, path, index)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gmailRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return gmailStat(this.accessor, path, index)
  }

  override getState(): Promise<GmailVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGmailConfig(this.config),
    })
  }
}
