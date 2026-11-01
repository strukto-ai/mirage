import { Mem0Accessor } from '../../accessor/mem0.ts'
import { readStream } from '../../core/mem0/read.ts'
import { readdir } from '../../core/mem0/readdir.ts'
import { searchMany } from '../../core/mem0/search.ts'
import { stat } from '../../core/mem0/stat.ts'
import { type ByteSource } from '../../io/types.ts'
import type { FileStat, PathSpec, SearchQuery } from '../../types.ts'
import { VFSName, type DirListing } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { RedactedSchema } from '../secrets.ts'
import { redactConfigWithSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'
import { Mem0Config } from './config.ts'

export const VFS_MD = `{prefix}
  <memory-id>.json`

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

  constructor(config: Mem0Config) {
    super()
    this.config = config
    this.accessor = new Mem0Accessor(config)
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return readdir(this.accessor, path, null, null, handed?.limit)
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

  override getState(): ConfigState<RedactedSchema<typeof Mem0Config>> {
    const config: RedactedSchema<typeof Mem0Config> = redactConfigWithSchema(
      Mem0Config,
      this.config,
    ) as RedactedSchema<typeof Mem0Config>
    return { type: this.name, config }
  }
}
