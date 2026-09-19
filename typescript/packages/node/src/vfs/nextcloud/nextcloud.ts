import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { VFSName } from '@struktoai/mirage-core/types'
import type { DeltaHook } from '@struktoai/mirage-core/watch/index'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { NEXTCLOUD_COMMANDS } from '../../commands/builtin/nextcloud/index.ts'
import { buildDeltaHook } from '../../core/nextcloud/watch.ts'
import { NEXTCLOUD_OPS } from '../../ops/nextcloud/index.ts'
import {
  redactNextcloudConfig,
  type NextcloudConfig,
  type NextcloudConfigRedacted,
} from './config.ts'
import { NEXTCLOUD_PROMPT } from './prompt.ts'
export interface NextcloudVFSState {
  type: string
  config: NextcloudConfigRedacted
}

export class NextcloudVFS extends BaseVFS {
  override readonly name = VFSName.NEXTCLOUD
  override readonly cachesReads = true
  // WebDAV PROPFIND carries getcontentlength for every file; readdir
  // backfills any lister-omitted size with one stat per affected file.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot = true
  override readonly prompt = NEXTCLOUD_PROMPT
  override readonly accessor: NextcloudAccessor
  constructor(readonly config: NextcloudConfig) {
    super()
    this.accessor = new NextcloudAccessor(config)
  }
  override commands(): readonly RegisteredCommand[] {
    return NEXTCLOUD_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return NEXTCLOUD_OPS
  }
  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<NextcloudVFSState> {
    return Promise.resolve({ type: this.name, config: redactNextcloudConfig(this.config) })
  }

  override loadState(_state: NextcloudVFSState): Promise<void> {
    return Promise.resolve()
  }
}
