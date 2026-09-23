import {
  redactSharePointConfig,
  SharePointAccessor,
  type SharePointConfig,
  type SharePointConfigRedacted,
} from '../../accessor/sharepoint.ts'
import { SHAREPOINT_COMMANDS } from '../../commands/builtin/sharepoint/index.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { read, readdir, stat } from '../../core/sharepoint/index.ts'
import { SHAREPOINT_OPS } from '../../ops/sharepoint/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName, type FileStat, type PathSpec } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { BaseVFS, type VFS } from '../base.ts'
import { SHAREPOINT_PROMPT } from './prompt.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { buildDeltaHook } from '../../core/sharepoint/watch.ts'

const resolveGlob = makeResolveGlob(readdir)

export interface SharePointVFSState {
  type: string
  config: SharePointConfigRedacted
}

export class SharePointVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.SHAREPOINT
  readonly cachesReads: boolean = true
  // Graph drive items carry an exact content-length size and the site
  // and drive levels are plain directories; unlike onedrive there is
  // no aggregate-size root item.
  readonly sizesAlwaysKnown: boolean = true
  readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = SHAREPOINT_PROMPT
  readonly accessor: SharePointAccessor
  private readonly config: SharePointConfig

  constructor(config: SharePointConfig) {
    super()
    this.config = config
    this.accessor = new SharePointAccessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return SHAREPOINT_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return SHAREPOINT_OPS
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

  override getState(): SharePointVFSState {
    const config: SharePointConfigRedacted = redactSharePointConfig(this.config)
    return { type: this.kind, config }
  }

  override loadState(_state: SharePointVFSState): Promise<void> {
    return Promise.resolve()
  }
}
