import { BaseVFS } from '../base.ts'
import { type ByteSource } from '../../io/types.ts'
import type { Handed } from '../types.ts'
import { Mem0Accessor } from '../../accessor/mem0.ts'
import { redactMem0Config, type Mem0Config, type Mem0ConfigRedacted } from './config.ts'

import { type DirListing, VFSName } from '../../types.ts'
import type { PathSpec, FileStat, SearchQuery } from '../../types.ts'
import { readdir } from '../../core/mem0/readdir.ts'
import { readStream } from '../../core/mem0/read.ts'
import { stat } from '../../core/mem0/stat.ts'
import { searchMany } from '../../core/mem0/search.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  <memory-id>.json`

export interface Mem0VFSState {
  type: string
  config: Mem0ConfigRedacted
}

export class Mem0VFS extends BaseVFS {
  override readonly handed = {
    read: ['entry'],
    stat: ['entry'],
  } as const

  override readonly name: string = VFSName.MEM0
  override readonly cachesReads: boolean = true
  // readdir and stat store the rendered JSON's byte length and read
  // serves those same bytes, so sizes are exact by construction.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = false
  override vfsMd: string = VFS_MD
  override readonly accessor: Mem0Accessor

  private readonly config: Mem0Config

  override readonly walkLimit: number
  constructor(config: Mem0Config) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    this.accessor = new Mem0Accessor(config)
  }

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return readdir(this.accessor, path)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async read(path: PathSpec, handed?: Handed): Promise<ByteSource> {
    return readStream(this.accessor, path, handed?.entry)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return stat(this.accessor, path, handed?.entry)
  }

  override search(path: PathSpec, query: SearchQuery): Promise<[string, string][] | null> {
    return searchMany(this.accessor, [path], query)
  }

  override searchMany(paths: PathSpec[], query: SearchQuery): Promise<[string, string][] | null> {
    return searchMany(this.accessor, paths, query)
  }

  override getState(): Mem0VFSState {
    const config: Mem0ConfigRedacted = redactMem0Config(this.config)
    return { type: this.name, config }
  }
}
