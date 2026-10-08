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
import { LangfuseAccessor } from '../../accessor/langfuse.ts'

import { HttpLangfuseTransport } from '../../core/langfuse/client.ts'

import { PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactLangfuseConfig, type LangfuseConfig, type LangfuseConfigRedacted } from './config.ts'
import type { PathSpec, FileStat, JsonValue } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import type { SearchQuery, SearchOp } from '../types.ts'
import { readdir as langfuseReaddir } from '../../core/langfuse/readdir.ts'
import { read as langfuseRead } from '../../core/langfuse/read.ts'
import { stat as langfuseStat } from '../../core/langfuse/stat.ts'
import { makeSearchOp } from '../../core/hierarchy/search.ts'
import { detectScope } from '../../core/langfuse/scope.ts'
import { SEARCHERS } from '../../core/langfuse/search.ts'

const searchOp: SearchOp<LangfuseAccessor> = makeSearchOp(detectScope, SEARCHERS)

export interface LangfuseVFSState {
  type: string
  config: LangfuseConfigRedacted
}

export class LangfuseVFS extends BaseVFS {
  override readonly name: string = VFSName.LANGFUSE
  override readonly cachesReads: boolean = true
  override readonly prompt: string = PROMPT
  readonly config: LangfuseConfig
  override readonly accessor: LangfuseAccessor

  constructor(config: LangfuseConfig) {
    super()
    this.config = config
    const transportOpts: { publicKey: string; secretKey: string; host?: string } = {
      publicKey: config.publicKey,
      secretKey: config.secretKey,
    }
    if (config.host !== undefined) transportOpts.host = config.host
    const accessorConfig: {
      defaultTraceLimit?: number
      defaultSearchLimit?: number
      defaultFromTimestamp?: string
    } = {}
    if (config.defaultTraceLimit !== undefined) {
      accessorConfig.defaultTraceLimit = config.defaultTraceLimit
    }
    if (config.defaultSearchLimit !== undefined) {
      accessorConfig.defaultSearchLimit = config.defaultSearchLimit
    }
    if (config.defaultFromTimestamp !== undefined) {
      accessorConfig.defaultFromTimestamp = config.defaultFromTimestamp
    }
    this.accessor = new LangfuseAccessor(new HttpLangfuseTransport(transportOpts), accessorConfig)
  }

  override readonly searchMeta: Readonly<Record<string, JsonValue>> = { grep: { mode: 'regex' } }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return langfuseReaddir(this.accessor, path, index)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await langfuseRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return langfuseStat(this.accessor, path, index)
  }

  override search(
    path: PathSpec,
    query: SearchQuery,
    index?: IndexCacheStore,
  ): Promise<string[] | null> {
    return searchOp(this.accessor, path, query, index)
  }

  override getState(): Promise<LangfuseVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactLangfuseConfig(this.config),
    })
  }
}
