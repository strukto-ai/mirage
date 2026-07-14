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

import { Session } from './session.ts'
import type { MountMode } from '../../types.ts'

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  readonly defaultId: string

  constructor(defaultSessionId: string) {
    this.defaultId = defaultSessionId
    this.sessions.set(defaultSessionId, new Session({ sessionId: defaultSessionId }))
  }

  get cwd(): string {
    return this.defaultSession().cwd
  }

  set cwd(value: string) {
    this.defaultSession().cwd = value
  }

  get env(): Record<string, string> {
    return this.defaultSession().env
  }

  set env(value: Record<string, string>) {
    this.defaultSession().env = value
  }

  create(
    sessionId: string,
    options: { mountModes?: ReadonlyMap<string, MountMode> | null } = {},
  ): Session {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`)
    }
    const session = new Session({
      sessionId,
      mountModes: options.mountModes ?? null,
    })
    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): Session {
    const s = this.sessions.get(sessionId)
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`)
    return s
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  close(sessionId: string): Promise<void> {
    if (sessionId === this.defaultId) {
      return Promise.reject(new Error('Cannot close the default session'))
    }
    if (!this.sessions.has(sessionId)) {
      return Promise.reject(new Error(`unknown session: ${sessionId}`))
    }
    this.sessions.delete(sessionId)
    return Promise.resolve()
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()].filter((id) => id !== this.defaultId)
    for (const id of ids) await this.close(id)
  }

  private defaultSession(): Session {
    const s = this.sessions.get(this.defaultId)
    if (s === undefined) throw new Error('default session missing')
    return s
  }
}
