import { BaseVFS } from '../base.ts'
import { type ByteSource } from '../../io/types.ts'
import type { Handed } from '../types.ts'
import { WandbAccessor } from '../../accessor/wandb.ts'

import { redactWandbConfig } from '../../core/wandb/config.ts'
import type { WandbConfig, WandbConfigRedacted } from '../../core/wandb/config.ts'

import { PROMPT } from '../../vfs/wandb/prompt.ts'
import { type DirListing, VFSName } from '../../types.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir } from '../../core/wandb/readdir.ts'
import { read, readStream } from '../../core/wandb/read.ts'
import { stat } from '../../core/wandb/stat.ts'
import { WALK_LIMIT } from '../constants.ts'

export interface WandbVFSState {
  type: string
  config: WandbConfigRedacted
}

export class WandbVFS extends BaseVFS {
  override readonly handed = {
    readdir: ['index'],
    stat: ['entry'],
  } as const

  override readonly name: string = VFSName.WANDB
  override readonly prompt: string = PROMPT
  readonly config: WandbConfig
  override readonly accessor: WandbAccessor

  override readonly walkLimit: number
  constructor(config: WandbConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    this.accessor = new WandbAccessor(config)
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return readdir(this.accessor, path, handed?.index)
  }

  override async read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> {
    if (offset === 0 && size === null) return readStream(this.accessor, path)
    const data = await read(this.accessor, path)
    return sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return stat(this.accessor, path, handed?.entry)
  }

  override getState(): Promise<WandbVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactWandbConfig(this.config),
    })
  }
}
