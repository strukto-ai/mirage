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

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { ShellExplanation } from '@struktoai/mirage-core/policy/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { MirageWorld } from '../world.ts'
import { MirageClient, type MirageRemote } from '@struktoai/mirage-core/remote/client'

const ON_SERVER = 'mirage: the workspace is on a Mirage server; reach it through ctx.mirage.remote'

/**
 * The `ready` of a remote world: it never resolves to a workspace, since
 * none is in this process. Marked observed, so a world nobody awaits does
 * not surface as an unhandled rejection.
 *
 * @returns a promise rejecting with why there is no local workspace.
 */
export function remoteOnly<W = Workspace>(): Promise<W> {
  const ready = Promise.reject<W>(new Error(ON_SERVER))
  void ready.catch(() => undefined)
  return ready
}

/** Configuration for {@link RemoteMirageService}. */
export interface RemoteMirageConfig {
  /** The workspace on a Mirage server. */
  remote: MirageRemote
}

/**
 * `ctx.mirage` for a workspace a Mirage server holds, with nothing of a
 * local workspace behind it: no mounts are built here and no host package
 * is loaded, so a host without a disk (a Worker) can compose it.
 *
 * `MirageService` from the package root takes the same `remote` config;
 * this is the build of it that never imports the local one.
 */
export class RemoteMirageService extends Service implements MirageWorld {
  static readonly provide = 'mirage'

  readonly remote: MirageClient
  readonly ready: Promise<Workspace> = remoteOnly()
  readonly workspaceIfReady: Workspace | null = null
  readonly vfsOnly = false

  constructor(ctx: Context, config: RemoteMirageConfig) {
    super(ctx, 'mirage')
    this.remote = new MirageClient(config.remote)
  }

  get workspace(): Workspace {
    throw new Error(ON_SERVER)
  }

  get decisions(): Workspace['decisions'] {
    throw new Error(`${ON_SERVER}; answer its asks at /v1/workspaces/{id}/asks`)
  }

  explain(line: string, sessionId = ''): Promise<ShellExplanation> {
    return this.remote.explain(line, sessionId)
  }

  hostPathToVirtual(): string | undefined {
    return undefined
  }
}
