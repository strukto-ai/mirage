import {
  OneDriveAccessor,
  redactOneDriveConfig,
  type OneDriveConfig,
  type OneDriveConfigRedacted,
} from '../../accessor/onedrive.ts'
import { ONEDRIVE_COMMANDS } from '../../commands/builtin/onedrive/index.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { read, readdir, stat } from '../../core/onedrive/index.ts'
import { ONEDRIVE_OPS } from '../../ops/onedrive/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { ResourceName, type FileStat, type PathSpec } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { BaseResource, type Resource } from '../base.ts'
import { ONEDRIVE_PROMPT } from './prompt.ts'

const resolveGlob = makeResolveGlob(readdir)

export class OneDriveResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.ONEDRIVE
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = ONEDRIVE_PROMPT
  readonly accessor: OneDriveAccessor
  private readonly config: OneDriveConfig

  constructor(config: OneDriveConfig) {
    super()
    this.config = config
    this.accessor = new OneDriveAccessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return ONEDRIVE_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return ONEDRIVE_OPS
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
    const config: OneDriveConfigRedacted = redactOneDriveConfig(this.config)
    return { type: this.kind, config }
  }

  loadState(_state: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}
