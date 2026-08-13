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

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { MountSpec } from '@struktoai/mirage-core'
import { Workspace } from '@struktoai/mirage-node'
import type { Mount, NodeWorkspaceOptions } from '@struktoai/mirage-node'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mirage: MirageService
  }
}

/**
 * Configuration for the shared mirage execution world. Exactly one of
 * `workspace` (adopt a live workspace the embedder owns and closes) or
 * `mounts` (construct a workspace here; the service closes it when its
 * plugin unloads) must be given.
 */
export interface MirageConfig {
  /** A live workspace to adopt; its lifecycle stays with the embedder. */
  workspace?: Workspace
  /** Mounts for a service-owned workspace, keyed by mount prefix. */
  mounts?: Record<string, MountSpec | Mount>
  /** Options forwarded to the service-owned workspace's constructor. */
  workspaceOptions?: NodeWorkspaceOptions
}

/**
 * The one mirage `Workspace` behind every mirage-backed dsh provider
 * (`ctx.mirage`, mirroring how `ctx.e2b` owns one sandbox for the E2B
 * adapters). `MirageFileSystem` and `MirageShellExecutor` both inject it,
 * which is what keeps `ctx.fs` targets and `ctx.shell` commands in one
 * execution world: a `processPath` handed to the shell resolves there.
 */
export class MirageService extends Service {
  static readonly provide = 'mirage'

  readonly workspace: Workspace

  constructor(ctx: Context, config: MirageConfig = {}) {
    super(ctx, 'mirage')
    if (config.workspace !== undefined && config.mounts !== undefined) {
      throw new Error('mirage: pass either workspace or mounts, not both')
    }
    if (config.workspace !== undefined) {
      this.workspace = config.workspace
      return
    }
    if (config.mounts === undefined) {
      throw new Error('mirage: one of workspace or mounts is required')
    }
    const owned = new Workspace(config.mounts, config.workspaceOptions ?? {})
    this.workspace = owned
    ctx.effect(() => () => owned.close(), 'mirage workspace')
  }
}
