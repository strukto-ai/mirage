import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'
import { Mem0Accessor } from '../../accessor/mem0.ts'
import { redactMem0Config, type Mem0Config, type Mem0ConfigRedacted } from './config.ts'

import { type DirListing, VFSName } from '../../types.ts'
import { PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '../../types.ts'
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
  override readonly handed = {
    read: ['entry'],
    stat: ['entry'],
    readStream: ['entry'],
  } as const

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

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return readdir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await read(this.accessor, path, handed?.entry)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
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

  override getState(): Mem0VFSState {
    const config: Mem0ConfigRedacted = redactMem0Config(this.config)
    return { type: this.name, config }
  }
}
