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
import { DifyAccessor } from '../../accessor/dify.ts'

import { VFSName } from '../../types.ts'
import {
  type DifyConfigRedacted,
  redactDifyConfig,
  resolveDifyConfig,
  type DifyConfig,
  type DifyConfigResolved,
} from './config.ts'
import { PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { SearchQuery } from '../types.ts'
import { DIFY_TREE } from '../../core/dify/tree.ts'
import { read, readStream } from '../../core/dify/read.ts'
import { stat } from '../../core/dify/stat.ts'
import { searchResource, searchMany } from '../../core/dify/search.ts'

export interface DifyVFSOptions {
  config: DifyConfig
}

export interface DifyVFSState {
  type: string
  config: DifyConfigRedacted
  needs_override: true
}

export class DifyVFS extends BaseVFS {
  override readonly name: string = VFSName.DIFY
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = false
  override readonly prompt: string = PROMPT
  readonly config: DifyConfigResolved
  override readonly accessor: DifyAccessor

  constructor(options: DifyVFSOptions | DifyConfig) {
    super()
    const config = 'config' in options ? options.config : options
    this.config = resolveDifyConfig(config)
    this.accessor = new DifyAccessor(this.config)
  }

  override getState(): DifyVFSState {
    return {
      type: this.name,
      config: redactDifyConfig(this.config),
      // TypeScript cannot rebuild a config-backed mount from state:
      // `buildMountArgs` substitutes a RAMVFS for anything it was
      // not handed. Saying so out loud turns a silently empty mount
      // into a refusal to load. Python rebuilds via its registry, so it
      // writes this on only four mounts and reads it nowhere.
      needs_override: true,
    }
  }

  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return DIFY_TREE.readdir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return read(this.accessor, path, index)
    return read(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return stat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return readStream(this.accessor, path, index)
  }

  override search(
    path: PathSpec,
    query: SearchQuery,
    index?: IndexCacheStore,
  ): Promise<string[] | null> {
    return searchResource(this.accessor, path, query, index)
  }

  override searchMany(
    paths: PathSpec[],
    query: SearchQuery,
    index?: IndexCacheStore,
  ): Promise<string[] | null> {
    return searchMany(this.accessor, paths, query, index)
  }
}
