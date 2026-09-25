import { BoundVFS } from '../bound.ts'
import { ONEDRIVE_IO } from '../../commands/builtin/onedrive/io.ts'
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
import { type VFS } from '../base.ts'
import { ONEDRIVE_PROMPT } from './prompt.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { buildDeltaHook } from '../../core/onedrive/watch.ts'

export interface OneDriveVFSState {
  type: string
  config: OneDriveConfigRedacted
}

export class OneDriveVFS extends BoundVFS<OneDriveAccessor> implements VFS {
  readonly kind: string = VFSName.ONEDRIVE
  readonly cachesReads: boolean = true
  // Graph driveItems carry an exact byte `size` for every file in both
  // listings and item gets; folders (including the root) report null with
  // the aggregate storage number in extra.
  readonly sizesAlwaysKnown: boolean = true
  readonly supportsSnapshot: boolean = true
  // stat and every read that can fill the cache stamp the item's cTag, the
  // read taking it before the bytes, so the gate compares like with like.
  readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = ONEDRIVE_PROMPT
  readonly accessor: OneDriveAccessor
  private readonly config: OneDriveConfig

  constructor(config: OneDriveConfig) {
    super(ONEDRIVE_IO)
    this.config = config
    this.accessor = new OneDriveAccessor(config)
  }

  commands(): readonly RegisteredCommand[] {
    return ONEDRIVE_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return ONEDRIVE_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): OneDriveVFSState {
    const config: OneDriveConfigRedacted = redactOneDriveConfig(this.config)
    return { type: this.kind, config }
  }
}
