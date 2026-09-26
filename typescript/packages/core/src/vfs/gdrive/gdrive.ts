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

import { BoundVFS } from '../bound.ts'
import { GDRIVE_IO } from '../../commands/builtin/gdrive/io.ts'
import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { GDRIVE_COMMANDS } from '../../commands/builtin/gdrive/index.ts'

import type { RegisteredCommand } from '../../commands/config.ts'

import { TokenManager } from '../../core/google/client.ts'
import { GDRIVE_OPS } from '../../ops/gdrive/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import type { VFS } from '../base.ts'
import { GDRIVE_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactGDriveConfig, type GDriveConfig, type GDriveConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/gdrive/watch.ts'
import { type DeltaHook } from '../../watch/index.ts'

export interface GDriveVFSState {
  type: string
  config: GDriveConfigRedacted
}

export class GDriveVFS extends BoundVFS<GDriveAccessor> implements VFS {
  readonly kind: string = VFSName.GDRIVE
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = true
  readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GDRIVE_PROMPT
  readonly config: GDriveConfig
  readonly accessor: GDriveAccessor

  constructor(config: GDriveConfig) {
    super(GDRIVE_IO)
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDriveAccessor({ tokenManager: tm })
  }

  commands(): readonly RegisteredCommand[] {
    return GDRIVE_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GDRIVE_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<GDriveVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGDriveConfig(this.config),
    })
  }
}
