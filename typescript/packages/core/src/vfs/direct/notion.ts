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

import { NotionAccessor } from '../../accessor/notion.ts'
import { HttpNotionTransport } from '../../core/notion/client.ts'
import { NotionConfig } from '../../core/notion/config.ts'
import { VFSName } from '../../types.ts'
import { NotionVFS as CoreNotionVFS, VFS_MD } from '../notion/notion.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState } from '../types.ts'

export class NotionVFS extends CoreNotionVFS {
  override readonly name: string = VFSName.NOTION
  override readonly cachesReads: boolean = true
  override vfsMd: string = VFS_MD
  readonly config: NotionConfig
  override readonly accessor: NotionAccessor

  constructor(config: NotionConfig) {
    super()
    this.config = config
    const transportOpts: {
      apiKey: string
      baseUrl?: string
      apiVersion?: string
      timeout?: number
    } = {
      apiKey: config.apiKey,
    }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    if (config.apiVersion !== undefined) transportOpts.apiVersion = config.apiVersion
    if (config.timeout !== undefined) transportOpts.timeout = config.timeout
    this.accessor = new NotionAccessor(new HttpNotionTransport(transportOpts))
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof NotionConfig>>> {
    return Promise.resolve(this.configState(NotionConfig, this.config))
  }
}
