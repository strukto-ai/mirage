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

- Read only. Only configured entities are visible. Run IDs are stable;
  display names may repeat.
- \`run.json\` holds identity, creator, sweep/group/job, tags, timestamps,
  notes, system metrics, history keys and count, and file count. Its
  \`user\` contains the creator's id, name, username and email, when
  available; its \`read_only\` is W&B's permission, not the mount mode.
  Missing run metadata is \`null\`.
- \`history.jsonl\` scans unsampled history in original order, preserving
  missing metrics and \`_step\`. Logged training-step keys are independent
  of \`_step\`. History reads may be large; use \`head\` to stream a prefix.
- \`summary.json\` metrics are stored values, not history maxima.
- \`files/\` keeps run-relative paths; \`files/wandb-metadata.json\`, when
  present, describes the machine and runtime environment.
- Listings and reads are lazy.`

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
