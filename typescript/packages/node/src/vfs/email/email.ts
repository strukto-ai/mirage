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

import { BaseVFS } from '@struktoai/mirage-core/vfs/base'

import { VFSName } from '@struktoai/mirage-core/types'

import { EmailAccessor } from '../../accessor/email.ts'

import {
  redactEmailConfig,
  type EmailConfig,
  type EmailConfigRedacted,
} from '../../core/email/config.ts'
import { PROMPT, WRITE_PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '@struktoai/mirage-core/types'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { sliceWindow } from '@struktoai/mirage-core/utils/ranges'
import { readdir as emailReaddir } from '../../core/email/readdir.ts'
import { read as emailRead } from '../../core/email/read.ts'
import { stat as emailStat } from '../../core/email/stat.ts'

export interface EmailVFSState {
  type: string
  config: EmailConfigRedacted
}

export class EmailVFS extends BaseVFS {
  override readonly name: string = VFSName.EMAIL
  override readonly cachesReads: boolean = true
  // Every listed file carries an exact size: .email.json is rendered at
  // readdir from the full message source the listing already fetches, and an
  // attachment's size is its decoded payload length.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: EmailConfig
  override readonly accessor: EmailAccessor

  constructor(config: EmailConfig) {
    super()
    this.config = config
    this.accessor = new EmailAccessor(config)
  }

  override async close(): Promise<void> {
    await this.accessor.close()
    await super.close()
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return emailReaddir(this.accessor, path, index)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await emailRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return emailStat(this.accessor, path, index)
  }

  override getState(): Promise<EmailVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactEmailConfig(this.config),
    })
  }
}
