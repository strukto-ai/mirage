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

import { NotionVFSBase } from '@struktoai/mirage-core/vfs/notion/notion'
import { NotionAccessor } from '@struktoai/mirage-core/accessor/notion'

import { HttpNotionTransport } from '@struktoai/mirage-core/core/notion/client'
import { redactNotionConfig } from '@struktoai/mirage-core/core/notion/config'
import type { NotionConfig, NotionConfigRedacted } from '@struktoai/mirage-core/core/notion/config'

import { PROMPT, WRITE_PROMPT } from '@struktoai/mirage-core/vfs/notion/prompt'
import { VFSName } from '@struktoai/mirage-core/types'

export interface NotionVFSState {
  type: string
  config: NotionConfigRedacted
}

export class NotionVFS extends NotionVFSBase {
  override readonly name: string = VFSName.NOTION
  override readonly cachesReads: boolean = true
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: NotionConfig
  override readonly accessor: NotionAccessor

  constructor(config: NotionConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string; apiVersion?: string } = {
      apiKey: config.apiKey,
    }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    if (config.apiVersion !== undefined) transportOpts.apiVersion = config.apiVersion
    this.accessor = new NotionAccessor(new HttpNotionTransport(transportOpts))
  }

  override getState(): Promise<NotionVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactNotionConfig(this.config),
    })
  }
}
