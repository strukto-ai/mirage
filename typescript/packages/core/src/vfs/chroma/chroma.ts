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

import { type ByteSource } from '../../io/types.ts'
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
import type { DirListing, PathSpec, FileStat, SearchQuery } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import type { Handed } from '../types.ts'
import { CHROMA_TREE } from '../../core/chroma/tree.ts'
import { read, readStream } from '../../core/chroma/read.ts'
import { stat } from '../../core/chroma/stat.ts'
import { filesContaining, searchMany } from '../../core/chroma/search.ts'
import { FULL_SCAN_LIMIT } from '../constants.ts'

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
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    stat: ['entry', 'index'],
  } as const

  override readonly fullScanLimit: number
  constructor(options: ChromaVFSOptions | ChromaConfig) {
    super()
    const config = 'config' in options ? options.config : options
    this.fullScanLimit = config.fullScanLimit ?? FULL_SCAN_LIMIT
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

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return CHROMA_TREE.readdir(this.accessor, path, handed?.entry)
  }

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> {
    if (offset === 0 && size === null) return readStream(this.accessor, path, handed?.entry)
    const data = await read(this.accessor, path, handed?.entry)
    return sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return stat(this.accessor, path, handed?.entry, handed?.index)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    return filesContaining(this.accessor, text, [path], opts.ignoreCase)
  }

  override search(path: PathSpec, query: SearchQuery): Promise<[string, string][] | null> {
    return searchMany(this.accessor, [path], query)
  }

  override searchMany(paths: PathSpec[], query: SearchQuery): Promise<[string, string][] | null> {
    return searchMany(this.accessor, paths, query)
  }
}
