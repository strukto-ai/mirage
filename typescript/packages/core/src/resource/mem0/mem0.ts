import { Mem0Accessor } from '../../accessor/mem0.ts'
import { redactMem0Config, type Mem0Config, type Mem0ConfigRedacted } from './config.ts'
import { MEM0_COMMANDS } from '../../commands/builtin/mem0/index.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { read, readdir, stat } from '../../core/mem0/index.ts'
import { MEM0_OPS } from '../../ops/mem0/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { ResourceName, type FileStat, type PathSpec } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { BaseResource, type Resource } from '../base.ts'
import { MEM0_PROMPT } from './prompt.ts'

const resolveGlob = makeResolveGlob(readdir)

export class Mem0Resource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.MEM0
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = false
  readonly prompt: string = MEM0_PROMPT
  readonly accessor: Mem0Accessor

  private readonly config: Mem0Config

  constructor(config: Mem0Config) {
    super()
    this.config = config
    this.accessor = new Mem0Accessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return MEM0_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return MEM0_OPS
  }

  glob(paths: readonly PathSpec[], _prefix = ''): Promise<PathSpec[]> {
    return resolveGlob(this.accessor, paths, this.index)
  }

  readFile(path: PathSpec): Promise<Uint8Array> {
    return read(this.accessor, path, this.index)
  }

  readdir(path: PathSpec): Promise<string[]> {
    return readdir(this.accessor, path, this.index)
  }

  stat(path: PathSpec): Promise<FileStat> {
    return stat(this.accessor, path, this.index)
  }

  getState(): Record<string, unknown> {
    const config: Mem0ConfigRedacted = redactMem0Config(this.config)
    return { type: this.kind, config }
  }

  loadState(_state: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}
