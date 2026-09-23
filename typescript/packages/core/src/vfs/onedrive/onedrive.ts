import {
  OneDriveAccessor,
  redactOneDriveConfig,
  type OneDriveConfig,
  type OneDriveConfigRedacted,
} from '../../accessor/onedrive.ts'
import { ONEDRIVE_COMMANDS } from '../../commands/builtin/onedrive/index.ts'
import { ONEDRIVE_OPS } from '../../ops/onedrive/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { BaseVFS } from '../base.ts'
import { ONEDRIVE_PROMPT } from './prompt.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { buildDeltaHook } from '../../core/onedrive/watch.ts'
export interface OneDriveVFSState {
  type: string
  config: OneDriveConfigRedacted
}

export class OneDriveVFS extends BaseVFS {
  override readonly name: string = VFSName.ONEDRIVE
  override readonly cachesReads: boolean = true
  // Graph driveItems carry an exact byte `size` for every file in both
  // listings and item gets; folders (including the root) report null with
  // the aggregate storage number in extra.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = ONEDRIVE_PROMPT
  override readonly accessor: OneDriveAccessor
  private readonly config: OneDriveConfig

  constructor(config: OneDriveConfig) {
    super()
    this.config = config
    this.accessor = new OneDriveAccessor(config)
  }
  override commands(): readonly RegisteredCommand[] {
    return ONEDRIVE_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return ONEDRIVE_OPS
  }
  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): OneDriveVFSState {
    const config: OneDriveConfigRedacted = redactOneDriveConfig(this.config)
    return { type: this.name, config }
  }

  override loadState(_state: OneDriveVFSState): Promise<void> {
    return Promise.resolve()
  }
}
