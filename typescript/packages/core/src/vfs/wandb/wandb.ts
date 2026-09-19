import { WandbAccessor } from '../../accessor/wandb.ts'
import { WANDB_COMMANDS } from '../../commands/builtin/wandb/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { redactWandbConfig } from '../../core/wandb/config.ts'
import type { WandbConfig, WandbConfigRedacted } from '../../core/wandb/config.ts'
import { WANDB_OPS } from '../../ops/wandb/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { WANDB_PROMPT } from '../../vfs/wandb/prompt.ts'
import { VFSName } from '../../types.ts'
export interface WandbVFSState {
  type: string
  config: WandbConfigRedacted
}

export class WandbVFS extends BaseVFS {
  override readonly name: string = VFSName.WANDB
  override readonly indexTtl: number = 600
  override readonly prompt: string = WANDB_PROMPT
  readonly config: WandbConfig
  override readonly accessor: WandbAccessor

  constructor(config: WandbConfig) {
    super()
    this.config = config
    this.accessor = new WandbAccessor(config)
  }
  override commands(): readonly RegisteredCommand[] {
    return WANDB_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return WANDB_OPS
  }
  override getState(): Promise<WandbVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactWandbConfig(this.config),
    })
  }

  override loadState(_state: WandbVFSState): Promise<void> {
    return Promise.resolve()
  }
}
