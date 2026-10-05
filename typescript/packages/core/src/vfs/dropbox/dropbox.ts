// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { BaseVFS } from '../base.ts'
import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { DROPBOX_COMMANDS } from '../../commands/builtin/dropbox/index.ts'

import type { RegisteredCommand } from '../../commands/config.ts'
import { DropboxTokenManager } from '../../core/dropbox/client.ts'

import { DROPBOX_OPS } from '../../ops/dropbox/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import { PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactDropboxConfig, type DropboxConfig, type DropboxConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/dropbox/watch.ts'
import { type DeltaHook } from '../../watch/index.ts'

export interface DropboxVFSState {
  type: string
  config: DropboxConfigRedacted
}

export class DropboxVFS extends BaseVFS {
  override readonly name: string = VFSName.DROPBOX
  override readonly cachesReads: boolean = true
  // list_folder carries an exact byte `size` for every file (0 included).
  // Paper docs 409 on raw download, a loud error, never a silent empty read.
  override readonly sizesAlwaysKnown: boolean = true
  // stat and every read stamp content_hash: a listing row and get_metadata
  // carry it, and a download, ranged or not, names it in Dropbox-API-Result
  // at no extra request.
  override readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = PROMPT
  readonly config: DropboxConfig
  override readonly accessor: DropboxAccessor

  constructor(config: DropboxConfig) {
    super()
    this.config = config
    const tm = new DropboxTokenManager(config)
    this.accessor = new DropboxAccessor({
      tokenManager: tm,
      ...(config.rootPath !== undefined ? { rootPath: config.rootPath } : {}),
      ...(config.contentSearch !== undefined ? { contentSearch: config.contentSearch } : {}),
    })
  }

  override commands(): readonly RegisteredCommand[] {
    return DROPBOX_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return DROPBOX_OPS
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<DropboxVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactDropboxConfig(this.config),
    })
  }
}
