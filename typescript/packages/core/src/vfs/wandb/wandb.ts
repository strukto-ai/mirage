import { BaseVFS } from '../base.ts'
import { WandbAccessor } from '../../accessor/wandb.ts'

import { redactWandbConfig } from '../../core/wandb/config.ts'
import type { WandbConfig, WandbConfigRedacted } from '../../core/wandb/config.ts'

import { PROMPT } from '../../vfs/wandb/prompt.ts'
import { VFSName } from '../../types.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir } from '../../core/wandb/readdir.ts'
import { read, readStream } from '../../core/wandb/read.ts'
import { stat } from '../../core/wandb/stat.ts'

export interface WandbVFSState {
  type: string
  config: WandbConfigRedacted
}

export class WandbVFS extends BaseVFS {
  override readonly name: string = VFSName.WANDB
  override readonly prompt: string = PROMPT
  override readonly maxDuEntries: number | null = 1000
  readonly config: WandbConfig
  override readonly accessor: WandbAccessor

  constructor(config: WandbConfig) {
    super()
    this.config = config
    this.accessor = new WandbAccessor(config)
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

  override getState(): Promise<WandbVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactWandbConfig(this.config),
    })
  }
}
