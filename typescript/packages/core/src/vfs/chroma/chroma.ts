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

import { ChromaAccessor } from '../../accessor/chroma.ts'
import { readStream } from '../../core/chroma/read.ts'
import { filesContaining, searchMany } from '../../core/chroma/search.ts'
import { stat } from '../../core/chroma/stat.ts'
import { CHROMA_TREE } from '../../core/chroma/tree.ts'
import { type ByteSource } from '../../io/types.ts'
import type { DirListing, FileStat, PathSpec, SearchQuery } from '../../types.ts'
import { VFSName } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { ConfigState, Handed } from '../types.ts'
import { redactChromaConfig, resolveChromaConfig, type ChromaConfig } from './config.ts'

export const VFS_MD = `Chroma is mounted as a read-only virtual filesystem backed by a ChromaDB
collection.

Use cat, head, tail, ls, find, tree, and grep to inspect indexed documents.
Paths are document slugs from the collection path tree. Writes are not
supported.`

export interface ChromaVFSOptions {
  config: ChromaConfig
}

export class ChromaVFS extends BaseVFS {
  override readonly name: string = VFSName.CHROMA
  override readonly cachesReads: boolean = false
  override readonly supportsSnapshot: boolean = false
  // Every file is sized exactly, by one chunk scan per directory the caller
  // stats; the path tree's own size is the producer's source number and
  // never becomes the reported byte length.
  override readonly sizesAlwaysKnown: boolean = true
  override vfsMd: string = VFS_MD
  readonly config: ReturnType<typeof resolveChromaConfig>
  override readonly accessor: ChromaAccessor
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    stat: ['entry', 'index'],
  } as const

  constructor(options: ChromaVFSOptions | ChromaConfig) {
    super()
    const config = 'config' in options ? options.config : options
    this.config = resolveChromaConfig(config)
    this.accessor = new ChromaAccessor(this.config)
  }

  override getState(): ConfigState<ReturnType<typeof redactChromaConfig>> & {
    needs_override: true
  } {
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

  // eslint-disable-next-line @typescript-eslint/require-await
  override async read(path: PathSpec, handed?: Handed): Promise<ByteSource> {
    return readStream(this.accessor, path, handed?.entry)
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
