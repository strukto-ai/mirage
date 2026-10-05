import { BaseVFS } from '../base.ts'
import { WandbAccessor } from '../../accessor/wandb.ts'

import { WANDB_COMMANDS } from '../../commands/builtin/wandb/index.ts'
import { IO } from '../../commands/builtin/wandb/io.ts'
import { DEFAULT_MAX_DU_ENTRIES } from '../../commands/builtin/generic/du.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { redactWandbConfig } from '../../core/wandb/config.ts'
import type { WandbConfig, WandbConfigRedacted } from '../../core/wandb/config.ts'

import { WANDB_OPS } from '../../ops/wandb/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import { PROMPT } from '../../vfs/wandb/prompt.ts'
import { VFSName } from '../../types.ts'

export interface WandbVFSState {
  type: string
  config: WandbConfigRedacted
}

export class WandbVFS extends BaseVFS {
  override readonly name: string = VFSName.WANDB
  override readonly prompt: string = PROMPT
  override readonly maxDuEntries: number | null =
    IO.maxDuEntries === undefined ? DEFAULT_MAX_DU_ENTRIES : IO.maxDuEntries
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
}
