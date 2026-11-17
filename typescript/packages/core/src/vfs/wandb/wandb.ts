import { WandbAccessor } from '../../accessor/wandb.ts'
import { WandbConfig } from '../../core/wandb/config.ts'
import { readStream } from '../../core/wandb/read.ts'
import { readdir } from '../../core/wandb/readdir.ts'
import { stat } from '../../core/wandb/stat.ts'
import { type ByteSource } from '../../io/types.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { type DirListing, VFSName } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'

export const VFS_MD = `\`\`\`text
{prefix}
  <entity>/
    <project>/
      <run-id>/
        run.json
        config.json
        summary.json
        history.jsonl
        files/
\`\`\`

- Read only; only configured entities are visible. Run ids are stable,
  display names may repeat.
- \`run.json\` holds identity, creator, sweep, group, tags, timestamps,
  notes and system metrics; its \`read_only\` is W&B's permission, not the
  mount mode.
- \`history.jsonl\` is the full unsampled history in logged order and can
  be large; \`head\` streams a prefix.
- \`summary.json\` holds stored values, not history maxima.
- \`files/\` keeps run-relative paths; \`files/wandb-metadata.json\`
  describes the machine and environment.`

export class WandbVFS extends BaseVFS {
  override readonly handed = {
    readdir: ['index'],
    stat: ['entry'],
  } as const

  override readonly name: string = VFSName.WANDB
  override vfsMd: string = VFS_MD
  readonly config: WandbConfig
  override readonly accessor: WandbAccessor

  constructor(config: WandbConfig) {
    super()
    this.config = config
    this.accessor = new WandbAccessor(config)
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return readdir(this.accessor, path, handed?.index, handed?.limit)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async read(path: PathSpec): Promise<ByteSource> {
    return readStream(this.accessor, path)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return stat(this.accessor, path, handed?.entry)
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof WandbConfig>>> {
    return Promise.resolve(this.configState(WandbConfig, this.config))
  }
}
