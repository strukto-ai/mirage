import { BaseVFS } from '../base.ts'
import { Mem0Accessor } from '../../accessor/mem0.ts'
import { redactMem0Config, type Mem0Config, type Mem0ConfigRedacted } from './config.ts'

import { VFSName } from '../../types.ts'
import { PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import type { SearchQuery } from '../types.ts'
import { readdir } from '../../core/mem0/readdir.ts'
import { read, readStream } from '../../core/mem0/read.ts'
import { stat } from '../../core/mem0/stat.ts'
import { searchResource, searchMany } from '../../core/mem0/search.ts'

export interface Mem0VFSState {
  type: string
  config: Mem0ConfigRedacted
}

export class Mem0VFS extends BaseVFS {
  override readonly name: string = VFSName.MEM0
  override readonly cachesReads: boolean = true
  // readdir and stat store the rendered JSON's byte length and read
  // serves those same bytes, so sizes are exact by construction.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = false
  override readonly prompt: string = PROMPT
  override readonly accessor: Mem0Accessor

  private readonly config: Mem0Config

  constructor(config: Mem0Config) {
    super()
    this.config = config
    this.accessor = new Mem0Accessor(config)
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return readdir(this.accessor, path, index)
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

  override getState(): Mem0VFSState {
    const config: Mem0ConfigRedacted = redactMem0Config(this.config)
    return { type: this.name, config }
  }
}
