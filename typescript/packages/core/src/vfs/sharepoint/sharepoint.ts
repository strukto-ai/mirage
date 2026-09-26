import { BoundVFS } from '../bound.ts'
import { SHAREPOINT_IO } from '../../commands/builtin/sharepoint/io.ts'
import {
  redactSharePointConfig,
  SharePointAccessor,
  type SharePointConfig,
  type SharePointConfigRedacted,
} from '../../accessor/sharepoint.ts'
import { SHAREPOINT_COMMANDS } from '../../commands/builtin/sharepoint/index.ts'

import { SHAREPOINT_OPS } from '../../ops/sharepoint/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { type VFS } from '../base.ts'
import { SHAREPOINT_PROMPT } from './prompt.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { buildDeltaHook } from '../../core/sharepoint/watch.ts'

export interface SharePointVFSState {
  type: string
  config: SharePointConfigRedacted
}

export class SharePointVFS extends BoundVFS<SharePointAccessor> implements VFS {
  readonly kind: string = VFSName.SHAREPOINT
  readonly cachesReads: boolean = true
  // Graph drive items carry an exact content-length size and the site
  // and drive levels are plain directories; unlike onedrive there is
  // no aggregate-size root item.
  readonly sizesAlwaysKnown: boolean = true
  readonly supportsSnapshot: boolean = true
  // stat and every read that can fill the cache stamp the item's cTag, the
  // read taking it before the bytes, so the gate compares like with like.
  readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = SHAREPOINT_PROMPT
  readonly accessor: SharePointAccessor
  private readonly config: SharePointConfig

  constructor(config: SharePointConfig) {
    super(SHAREPOINT_IO)
    this.config = config
    this.accessor = new SharePointAccessor(config)
  }

  commands(): readonly RegisteredCommand[] {
    return SHAREPOINT_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return SHAREPOINT_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): SharePointVFSState {
    const config: SharePointConfigRedacted = redactSharePointConfig(this.config)
    return { type: this.kind, config }
  }
}
