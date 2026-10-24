import { BaseVFS } from '../base.ts'
import { type ByteSource } from '../../io/types.ts'
import type { Handed } from '../types.ts'
import { WandbAccessor } from '../../accessor/wandb.ts'

import { redactWandbConfig } from '../../core/wandb/config.ts'
import type { WandbConfig, WandbConfigRedacted } from '../../core/wandb/config.ts'

import { type DirListing, VFSName } from '../../types.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { readdir } from '../../core/wandb/readdir.ts'
import { readStream } from '../../core/wandb/read.ts'
import { stat } from '../../core/wandb/stat.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `Read-only W&B experiments: /<entity>/<project>/<run-id>/ contains
run.json (identity, creator, sweep/group/job, tags, timestamps, notes, system metrics,
history keys/count and file count), config.json, summary.json, history.jsonl and files/.
Run IDs are stable; display names may repeat. history.jsonl scans unsampled history
in original order, preserving missing metrics and _step. Logged training-step keys
are independent of _step. Summary metrics are stored values, not history maxima.
Listings and reads are lazy. History reads may be large; use head to stream a prefix.
Only configured entities are visible. Files retain their run-relative paths.
files/wandb-metadata.json, when present, describes the machine/runtime environment.
run.json user contains the creator's id, name, username and email, when available.
Missing run metadata is null. run.json read_only is W&B's permission, not mount mode.
`

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
  override vfsMd: string = VFS_MD
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

  // eslint-disable-next-line @typescript-eslint/require-await
  override async read(path: PathSpec): Promise<ByteSource> {
    return readStream(this.accessor, path)
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
