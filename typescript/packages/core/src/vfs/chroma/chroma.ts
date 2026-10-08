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
import { ChromaAccessor } from '../../accessor/chroma.ts'

import { VFSName } from '../../types.ts'
import {
  type ChromaConfigRedacted,
  redactChromaConfig,
  resolveChromaConfig,
  type ChromaConfig,
  type ChromaConfigResolved,
} from './config.ts'
import { PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import type { SearchQuery } from '../types.ts'
import { CHROMA_TREE } from '../../core/chroma/tree.ts'
import { read, readStream } from '../../core/chroma/read.ts'
import { stat } from '../../core/chroma/stat.ts'
import { searchResource, searchMany } from '../../core/chroma/search.ts'

export interface ChromaVFSOptions {
  config: ChromaConfig
}

export interface ChromaVFSState {
  type: string
  config: ChromaConfigRedacted
  needs_override: true
}

export class ChromaVFS extends BaseVFS {
  override readonly name: string = VFSName.CHROMA
  override readonly cachesReads: boolean = false
  override readonly supportsSnapshot: boolean = false
  // Every file is sized exactly, by one chunk scan per directory the caller
  // stats; the path tree's own size is the producer's source number and
  // never becomes the reported byte length.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly prompt: string = PROMPT
  readonly config: ChromaConfigResolved
  override readonly accessor: ChromaAccessor

  constructor(options: ChromaVFSOptions | ChromaConfig) {
    super()
    const config = 'config' in options ? options.config : options
    this.config = resolveChromaConfig(config)
    this.accessor = new ChromaAccessor(this.config)
  }

  override getState(): ChromaVFSState {
    return {
      type: this.name,
      config: redactChromaConfig(this.config),
      // TypeScript cannot rebuild a config-backed mount from state:
      // `buildMountArgs` substitutes a RAMVFS for anything it was
      // not handed. Saying so out loud turns a silently empty mount
      // into a refusal to load. Python rebuilds via its registry, so it
      // writes this on only four mounts and reads it nowhere.
      needs_override: true,
    }
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return CHROMA_TREE.readdir(this.accessor, path, index)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await read(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
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
