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

import { KeyLock } from '../../cache/lock.ts'
import { runWithSession } from '../../context/session_context.ts'
import type { OpsRegistry } from '../../ops/registry.ts'
import type { Ops } from '../../ops/ops.ts'
import type { CompiledProfile } from '../../policy/profile.ts'
import { DEFAULT_READ_SPEC, FileType, MountMode, PathSpec } from '../../types.ts'
import { eexist, enoent, enotdir, isEnoent } from '../../errors/fs.ts'
import { pathVisible } from '../../utils/hidden.ts'
import { norm, parent } from '../../utils/path.ts'
import { DocumentVFS } from '../../vfs/document/document.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionManager } from '../session/manager.ts'
import { applyProfile } from '../session/resolve.ts'
import { SessionState } from '../session/session.ts'
import * as render from './render.ts'

export class Documents {
  readonly views = new Map<string, DocumentVFS>()
  private readonly lock = new KeyLock()

  constructor(
    private readonly registry: MountRegistry,
    private readonly opsRegistry: OpsRegistry,
    private readonly ops: Ops,
    private readonly manager: SessionManager,
    private readonly session: () => SessionState,
    private readonly profile: (name: string) => CompiledProfile,
    private readonly ensureLoaded: () => Promise<void>,
    private readonly unmount: (path: string) => Promise<void>,
    private readonly followParent: (path: string) => string,
  ) {}

  render(kind: 'vfs' | 'skill'): string {
    return (kind === 'vfs' ? render.vfsMd : render.skillMd)(this.registry, this.session())
  }

  /** Drop every binding; a snapshot load restores none. */
  async clear(): Promise<void> {
    await this.lock.withLock('documents', async () => {
      for (const path of [...this.views.keys()]) await this.unmount(path)
    })
  }

  async releaseSession(sessionId: string): Promise<void> {
    await this.lock.withLock('documents', async () => {
      for (const [path, view] of this.views) {
        view.sessions.delete(sessionId)
        if (!view.globalView && view.sessions.size === 0) await this.unmount(path)
      }
    })
  }

  async get(
    kind: 'vfs' | 'skill',
    path?: string | PathSpec,
    profile?: string,
    sessionId?: string,
  ): Promise<string> {
    if (profile !== undefined && (path !== undefined || sessionId !== undefined)) {
      throw new Error('profile is only valid for generation without a path or session')
    }
    await this.ensureLoaded()
    let session: SessionState
    if (profile !== undefined) {
      session = new SessionState({ sessionId: '' })
      applyProfile(session, this.profile(profile))
    } else session = sessionId === undefined ? this.session() : this.manager.get(sessionId)
    return runWithSession(
      session,
      async () => {
        if (path !== undefined) {
          const virtual = path instanceof PathSpec ? path.virtual : path
          if (
            norm(virtual) !== virtual ||
            virtual.includes('\0') ||
            virtual
              .slice(1)
              .split('/')
              .some((part) => ['', '.', '..'].includes(part))
          ) {
            throw new Error('document path must be an absolute, normalized file path')
          }
          // Bound where a later read lands: every link above the name is
          // followed, as the read's own walk follows it.
          const bound = this.followParent(virtual)
          if (![virtual, bound].every((p) => pathVisible(session.visibility, p)))
            throw enoent(virtual)
          await this.lock.withLock('documents', () =>
            this.expose(kind, bound, sessionId === undefined ? null : session),
          )
        }
        return this.render(kind)
      },
      this.manager,
    )
  }

  async expose(kind: 'vfs' | 'skill', path: string, session: SessionState | null): Promise<void> {
    const directory = await this.ops.stat(parent(path))
    if (directory.type !== FileType.DIRECTORY) throw enotdir(parent(path))
    let view = this.views.get(path)
    if (view !== undefined && view.kind !== kind) throw eexist(path)
    if (view === undefined) {
      // Collision checks are host-side: a hidden backend entry must not be
      // overwritten by a new view either.
      await runWithSession(
        new SessionState({ sessionId: '' }),
        async () => {
          try {
            await this.ops.stat(path, undefined, { nofollow: true })
          } catch (error) {
            if (isEnoent(error)) return
            throw error
          }
          throw eexist(path)
        },
        this.manager,
      )
      view = new DocumentVFS(path.slice(path.lastIndexOf('/') + 1), () => this.render(kind), kind)
      this.opsRegistry.registerVfs(view)
      const document = view
      const mount = this.registry.mount(path, view, MountMode.READ, DEFAULT_READ_SPEC)
      mount.visible = () =>
        document.globalView ||
        document.sessions.get(this.session().sessionId) === this.session().createdAt
      this.views.set(path, view)
    }
    if (session === null) view.globalView = true
    else view.sessions.set(session.sessionId, session.createdAt)
  }
}
