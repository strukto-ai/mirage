import { Mem0Accessor } from '../../accessor/mem0.ts'
import { redactMem0Config, type Mem0Config, type Mem0ConfigRedacted } from './config.ts'
import { MEM0_COMMANDS } from '../../commands/builtin/mem0/index.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { read } from '../../core/mem0/read.ts'
import { readdir } from '../../core/mem0/readdir.ts'
import { stat } from '../../core/mem0/stat.ts'
import { MEM0_OPS } from '../../ops/mem0/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName, type FileStat, type PathSpec } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { BaseVFS, type VFS } from '../base.ts'
import { MEM0_PROMPT } from './prompt.ts'

const resolveGlob = makeResolveGlob(readdir)

export interface Mem0VFSState {
  type: string
  config: Mem0ConfigRedacted
}

export class Mem0VFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.MEM0
  readonly cachesReads: boolean = true
  // readdir and stat store the rendered JSON's byte length and read
  // serves those same bytes, so sizes are exact by construction.
  readonly sizesAlwaysKnown: boolean = true
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

  override getState(): Mem0VFSState {
    const config: Mem0ConfigRedacted = redactMem0Config(this.config)
    return { type: this.kind, config }
  }

  override loadState(_state: Mem0VFSState): Promise<void> {
    return Promise.resolve()
  }
}
