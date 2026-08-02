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

import type { SessionManager } from '../session/manager.ts'
import type { WorkspaceFields, WorkspaceStateStore } from '../store/base.ts'

/**
 * The workspace's discovery record: who it is and which session is its
 * default. Mirrors the Python `WorkspaceMeta` in `workspace/meta.py`.
 *
 * A minted default session id is provisional: attaching to a workspace
 * whose record already names one adopts the stored pointer instead.
 */
export class WorkspaceMeta {
  private readonly wsId: string
  private readonly store: WorkspaceStateStore
  private readonly sessions: SessionManager
  private readonly sessionIdExplicit: boolean
  private written = false

  constructor(
    wsId: string,
    store: WorkspaceStateStore,
    sessions: SessionManager,
    sessionIdExplicit: boolean,
  ) {
    this.wsId = wsId
    this.store = store
    this.sessions = sessions
    this.sessionIdExplicit = sessionIdExplicit
  }

  /**
   * Write the discovery record once per process. An existing record
   * wins (another process or an earlier run already registered it); a
   * fresh workspace registers itself so siblings pointed at the same
   * store can find its sessions and default session.
   */
  async ensure(): Promise<void> {
    if (this.written) return
    let existing = await this.store.loadMeta(this.wsId)
    if (existing === null) {
      const created = await this.store.casSetMeta(
        this.wsId,
        {
          workspace_id: this.wsId,
          default_session_id: this.sessions.defaultId,
          created_at: Date.now() / 1000,
          generation: 1,
        },
        0,
      )
      if (!created) {
        // Lost the create race: a sibling registered first and its
        // record wins, like any other existing record.
        existing = await this.store.loadMeta(this.wsId)
      }
    }
    if (existing !== null) {
      const stored = existing.default_session_id
      if (!this.sessionIdExplicit && typeof stored === 'string') {
        this.sessions.adoptDefault(stored)
      }
    }
    this.written = true
  }

  /**
   * Snapshot restore: adopt the snapshot's default session identity and
   * point the discovery record at it.
   */
  async adoptDefault(sessionId: string): Promise<void> {
    this.sessions.adoptDefault(sessionId)
    await this.store.replaceMeta(this.wsId, {
      workspace_id: this.wsId,
      default_session_id: sessionId,
    })
    this.written = true
  }

  /** This workspace's metadata record (discovery surface). */
  async load(): Promise<WorkspaceFields> {
    await this.ensure()
    const meta = await this.store.loadMeta(this.wsId)
    return meta ?? {}
  }
}
