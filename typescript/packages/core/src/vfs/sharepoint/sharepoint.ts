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
import { BaseVFS } from '../base.ts'
import { SHAREPOINT_PROMPT } from './prompt.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { buildDeltaHook } from '../../core/sharepoint/watch.ts'
export interface SharePointVFSState {
  type: string
  config: SharePointConfigRedacted
}

export class SharePointVFS extends BaseVFS {
  override readonly name: string = VFSName.SHAREPOINT
  override readonly cachesReads: boolean = true
  // Graph drive items carry an exact content-length size and the site
  // and drive levels are plain directories; unlike onedrive there is
  // no aggregate-size root item.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = SHAREPOINT_PROMPT
  override readonly accessor: SharePointAccessor
  private readonly config: SharePointConfig

  constructor(config: SharePointConfig) {
    super()
    this.config = config
    this.accessor = new SharePointAccessor(config)
  }
  override commands(): readonly RegisteredCommand[] {
    return SHAREPOINT_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return SHAREPOINT_OPS
  }
  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): SharePointVFSState {
    const config: SharePointConfigRedacted = redactSharePointConfig(this.config)
    return { type: this.name, config }
  }

  override loadState(_state: SharePointVFSState): Promise<void> {
    return Promise.resolve()
  }
}
