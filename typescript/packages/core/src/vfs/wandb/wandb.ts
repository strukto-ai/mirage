import { WandbAccessor } from '../../accessor/wandb.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { WANDB_COMMANDS } from '../../commands/builtin/wandb/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { redactWandbConfig } from '../../core/wandb/config.ts'
import type { WandbConfig, WandbConfigRedacted } from '../../core/wandb/config.ts'
import { read as wandbRead } from '../../core/wandb/read.ts'
import { readdir as wandbReaddir } from '../../core/wandb/readdir.ts'
import { stat as wandbStat } from '../../core/wandb/stat.ts'
import { WANDB_OPS } from '../../ops/wandb/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../../vfs/base.ts'
import type { VFS } from '../../vfs/base.ts'
import { WANDB_PROMPT } from '../../vfs/wandb/prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'

const resolveWandbGlob = makeResolveGlob(wandbReaddir)

export interface WandbVFSState {
  type: string
  config: WandbConfigRedacted
}

export class WandbVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.WANDB
  override readonly indexTtl: number = 600
  readonly prompt: string = WANDB_PROMPT
  readonly config: WandbConfig
  readonly accessor: WandbAccessor

  constructor(config: WandbConfig) {
    super()
    this.config = config
    this.accessor = new WandbAccessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return WANDB_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return WANDB_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return wandbRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return wandbReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return wandbStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.vfsPath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  vfsPath: mountKey(p.virtual, prefix),
                }),
          )
        : paths
    return resolveWandbGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<WandbVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactWandbConfig(this.config),
    })
  }

  override loadState(_state: WandbVFSState): Promise<void> {
    return Promise.resolve()
  }
}
