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

import type { PathSpec } from '../../types.ts'
import type { Ops } from '../../ops/ops.ts'
import type { SessionState } from '../session/session.ts'
import type { FileVersionTracker } from '../tools/file_version.ts'
import type { MirageToolOperations } from '../tools/tool_operations.ts'
import type { ExecuteOptions, ExecuteResult } from './types.ts'
import type { Workspace } from './workspace.ts'

/** `ExecuteOptions` with the session already fixed. */
export type SessionExecuteOptions = Omit<ExecuteOptions, 'sessionId'>

/**
 * One session's doors, bound together.
 *
 * `shell` runs a line as the session, `vfs` is the op facade run as it
 * and `tools` the agent tools over both, so a host holds one object per
 * agent and every door answers under the same profile: hides, mount
 * modes, grants and standing decisions. Nothing is stored here; the session record stays with the
 * session manager and `state` reads it. Obtained from
 * `Workspace.session`, which creates the session or adopts it. A null id
 * is the workspace's default session as it is when each call runs, the
 * way `ws.vfs` and `ws.shell` follow it when a snapshot load or an attach
 * re-keys it.
 */
export class Session {
  private readonly ws: Workspace
  private readonly id: string | null

  constructor(ws: Workspace, sessionId: string | null) {
    this.ws = ws
    this.id = sessionId
  }

  get sessionId(): string {
    return this.id ?? this.ws.defaultSessionId
  }

  /** The session record: cwd, env, modes, hides, decisions. */
  get state(): SessionState {
    return this.ws.getSession(this.sessionId)
  }

  /** The op facade run as this session. */
  get vfs(): Ops {
    return this.id === null ? this.ws.vfs : this.ws.vfs.forSession(this.id)
  }

  /** The agent tools run as this session: one table per session, shared by every caller in the process. */
  get tools(): MirageToolOperations {
    return this.ws.sessionTools(this.id)
  }

  /**
   * The read history the session's agent tools share.
   *
   * @internal
   */
  reads(): Promise<FileVersionTracker> {
    return this.ws.sessionReads(this.id)
  }

  /** Run a shell line as this session; `Workspace.shell` with the session fixed. */
  shell(command: string, options: SessionExecuteOptions = {}): Promise<ExecuteResult> {
    return this.ws.shell(command, this.id === null ? options : { ...options, sessionId: this.id })
  }

  /** The paths a pattern matches as this session; `Workspace.glob` with the session fixed. */
  glob(pattern: string): Promise<string[]> {
    return this.id === null ? this.ws.glob(pattern) : this.ws.glob(pattern, this.id)
  }
  /** Render this session's VFS Markdown, optionally at a virtual path. */
  vfsMd(path?: string | PathSpec): Promise<string> {
    return this.ws.vfsMd(path, { sessionId: this.sessionId })
  }

  /** Render this session's CLI skill, optionally at a virtual path. */
  skillMd(path?: string | PathSpec): Promise<string> {
    return this.ws.skillMd(path, { sessionId: this.sessionId })
  }
}
