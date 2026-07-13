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

import { createAsyncContext } from '../utils/async_context.ts'
import type { Session } from '../workspace/session/session.ts'
import { stripSlash } from '../utils/slash.ts'
import { MountMode, weakerMode } from '../types.ts'

const sessionStorage = createAsyncContext<Session>()

export function runWithSession<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(sessionStorage.run(session, fn))
}

function getCurrentSession(): Session | null {
  return sessionStorage.getStore() ?? null
}

export class MountNotAllowedError extends Error {
  readonly sessionId: string
  readonly mountPrefix: string
  constructor(sessionId: string, mountPrefix: string) {
    super(`session '${sessionId}' not allowed to access mount '${mountPrefix}'`)
    this.name = 'MountNotAllowedError'
    this.sessionId = sessionId
    this.mountPrefix = mountPrefix
  }
}

function normPrefix(mountPrefix: string): string {
  const stripped = stripSlash(mountPrefix)
  return stripped === '' ? '/' : '/' + stripped
}

/**
 * The current session's grant for this mount: EXEC (no narrowing) when no
 * session is bound or the session is unrestricted, undefined when the
 * session has grants but none for this mount.
 */
function sessionGrant(mountPrefix: string): MountMode | undefined {
  const sess = getCurrentSession()
  if (sess?.mountGrants == null) return MountMode.EXEC
  return sess.mountGrants.get(normPrefix(mountPrefix))
}

/**
 * Throw if the current session may not touch this mount. A user-defined
 * root mount is governed like any other: a session must be granted `/`
 * to touch it.
 */
export function assertMountAllowed(mountPrefix: string): void {
  if (sessionGrant(mountPrefix) !== undefined) return
  const sess = getCurrentSession()
  throw new MountNotAllowedError(sess?.sessionId ?? '', normPrefix(mountPrefix))
}

/**
 * The mount mode after narrowing by the current session's grant. The
 * mount's own mode is the ceiling; a grant can only weaken it. A mount
 * absent from the grants map narrows to READ here; visibility denial is
 * `assertMountAllowed`'s job at the dispatch entry points.
 */
export function effectiveMountMode(mountPrefix: string, mountMode: MountMode): MountMode {
  const grant = sessionGrant(mountPrefix)
  if (grant === undefined) return MountMode.READ
  return weakerMode(mountMode, grant)
}
