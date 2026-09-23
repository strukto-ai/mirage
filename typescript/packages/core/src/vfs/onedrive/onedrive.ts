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
import { VFSName, type FileStat, type PathSpec } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { BaseVFS, type VFS } from '../base.ts'
import { ONEDRIVE_PROMPT } from './prompt.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { buildDeltaHook } from '../../core/onedrive/watch.ts'

const resolveGlob = makeResolveGlob(readdir)

export interface OneDriveVFSState {
  type: string
  config: OneDriveConfigRedacted
}

export class OneDriveVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.ONEDRIVE
  readonly cachesReads: boolean = true
  // Graph driveItems carry an exact byte `size` for every file in both
  // listings and item gets; folders (including the root) report null with
  // the aggregate storage number in extra.
  readonly sizesAlwaysKnown: boolean = true
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

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): OneDriveVFSState {
    const config: OneDriveConfigRedacted = redactOneDriveConfig(this.config)
    return { type: this.kind, config }
  }

  override loadState(_state: OneDriveVFSState): Promise<void> {
    return Promise.resolve()
  }
}
