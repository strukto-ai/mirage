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
import type { DirListing, PathSpec, FileStat } from '../../types.ts'
import type { Handed, SearchQuery } from '../types.ts'
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
  override readonly listsStats: boolean = true
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    readStream: ['entry'],
    stat: ['entry'],
  } as const
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

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return DIFY_TREE.readdir(this.accessor, path, handed?.entry)
  }

  override read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const entry = handed?.entry ?? null
    if (offset === 0 && size === null) return read(this.accessor, path, entry)
    return read(this.accessor, path, entry, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return stat(this.accessor, path, handed?.entry)
  }

  override readStream(path: PathSpec, handed?: Handed): AsyncIterable<Uint8Array> {
    return readStream(this.accessor, path, handed?.entry)
  }

  override search(path: PathSpec, query: SearchQuery): Promise<[string, string][] | null> {
    return searchResource(this.accessor, path, query)
  }

  override searchMany(paths: PathSpec[], query: SearchQuery): Promise<[string, string][] | null> {
    return searchMany(this.accessor, paths, query)
  }
}
