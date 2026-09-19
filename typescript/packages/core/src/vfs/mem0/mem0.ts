import { Mem0Accessor } from '../../accessor/mem0.ts'
import { redactMem0Config, type Mem0Config, type Mem0ConfigRedacted } from './config.ts'
import { MEM0_COMMANDS } from '../../commands/builtin/mem0/index.ts'
import { MEM0_OPS } from '../../ops/mem0/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { BaseVFS } from '../base.ts'
import { MEM0_PROMPT } from './prompt.ts'
export interface Mem0VFSState {
  type: string
  config: Mem0ConfigRedacted
}

export class Mem0VFS extends BaseVFS {
  override readonly name: string = VFSName.MEM0
  override readonly cachesReads: boolean = true
  // readdir and stat store the rendered JSON's byte length and read
  // serves those same bytes, so sizes are exact by construction.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = false
  override readonly prompt: string = MEM0_PROMPT
  override readonly accessor: Mem0Accessor

  private readonly config: Mem0Config

  constructor(config: Mem0Config) {
    super()
    this.config = config
    this.accessor = new Mem0Accessor(config)
  }
  override commands(): readonly RegisteredCommand[] {
    return MEM0_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return MEM0_OPS
  }
  override getState(): Mem0VFSState {
    const config: Mem0ConfigRedacted = redactMem0Config(this.config)
    return { type: this.name, config }
  }

  override loadState(_state: Mem0VFSState): Promise<void> {
    return Promise.resolve()
  }
}
