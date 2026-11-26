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

import type { ShellExplanation } from '@struktoai/mirage-core/policy/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { MirageClient } from '@struktoai/mirage-core/remote/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mirage: MirageWorld
  }
}

/**
 * The one execution world behind every mirage-backed dsh provider
 * (`ctx.mirage`): a workspace in this process, or one a Mirage server holds.
 *
 * Exactly one of the two is live. `remote` is the client when the world is
 * on a server, and null when it is here; the providers branch on it, so a
 * world in this process takes the same path it always has.
 */
export interface MirageWorld {
  /** The server's client when the world is remote; null when it is in this process. */
  readonly remote: MirageClient | null
  /** Resolves to the workspace in this process once its mounts are built; rejects for a remote world. */
  readonly ready: Promise<Workspace>
  /** The workspace in this process; throws until `ready` resolves, and for a remote world. */
  readonly workspace: Workspace
  /** The workspace in this process, or null while it builds and for a remote world. */
  readonly workspaceIfReady: Workspace | null
  /** The decisions of the workspace in this process. */
  readonly decisions: Workspace['decisions']
  /** True while every runtime in the world reaches only the VFS: the claim behind `workspace-write`. */
  readonly vfsOnly: boolean
  /**
   * What a line would do here, without doing it.
   *
   * @param line the command line to judge.
   * @param sessionId the session to judge it in; the default when empty.
   */
  explain(line: string, sessionId?: string): Promise<ShellExplanation>
  /**
   * The workspace path naming the same file as a path on this machine, when
   * a mount holds that file; undefined when none does.
   *
   * @param hostPath an absolute path on this machine.
   */
  hostPathToVirtual(hostPath: string): string | undefined
}
