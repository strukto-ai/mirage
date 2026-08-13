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
import { pathHidden } from '../utils/hidden.ts'
import { MountMode, weakerMode } from '../types.ts'

const sessionStorage = createAsyncContext<Session>()

export function runWithSession<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(sessionStorage.run(session, fn))
}

function getCurrentSession(): Session | null {
  return sessionStorage.getStore() ?? null
}

/**
 * A session touched a mount outside its allowlist.
 *
 * Stamped EACCES + operand so it behaves like python's `PermissionError`
 * from the same guard, which is a member of `FS_ERRORS`: callers that
 * handle filesystem errors per-operand (the redirect write pass) render
 * `<target>: Permission denied` instead of letting the guard's own prose
 * escape as the whole message. Callers that want the prose still read
 * `.message`, and the explicit `instanceof` checks in `command.ts` and the
 * FUSE bridge run before any of that and are unaffected.
 */
export class MountNotAllowedError extends Error {
  readonly sessionId: string
  readonly mountPrefix: string
  readonly code = 'EACCES'
  readonly virtualPath: string
  constructor(sessionId: string, mountPrefix: string) {
    super(`session '${sessionId}' not allowed to access mount '${mountPrefix}'`)
    this.name = 'MountNotAllowedError'
    this.sessionId = sessionId
    this.mountPrefix = mountPrefix
    this.virtualPath = mountPrefix
  }
}

function normPrefix(mountPrefix: string): string {
  const stripped = stripSlash(mountPrefix)
  return stripped === '' ? '/' : '/' + stripped
}

/**
 * The current session's mode cap for this mount: EXEC (no narrowing) when no
 * session is bound or the session is unrestricted, undefined when the
 * session has mount modes but none for this mount.
 */
function sessionMode(mountPrefix: string): MountMode | undefined {
  const sess = getCurrentSession()
  if (sess?.mountModes == null) return MountMode.EXEC
  return sess.mountModes.get(normPrefix(mountPrefix))
}

/**
 * Whether the current session may touch this mount at all.
 *
 * The non-raising twin of `assertMountAllowed`, for enumeration:
 * structure merges and fan-outs filter names through it, so a scoped
 * session never learns that an ungranted mount exists. True when no
 * session is bound or the session is unrestricted.
 */
export function mountAllowed(mountPrefix: string): boolean {
  return sessionMode(mountPrefix) !== undefined
}

/**
 * Whether the current session hides any paths at all.
 *
 * For a summarizing fast path (du -s asks the backend for one total)
 * that must not be trusted when hidden leaves could be inside it.
 */
export function hiddenPathsActive(): boolean {
  const sess = getCurrentSession()
  return sess?.hiddenPaths != null
}

/**
 * Whether the current session's hidden-paths spec leaves this path
 * visible.
 *
 * The path twin of `mountAllowed`: enumeration surfaces filter names
 * through it and the doors answer ENOENT (EACCES for creates) when it
 * says no, so hiding reads as nonexistence, never as a denial that
 * leaks the name. True when no session is bound or the session hides
 * nothing.
 */
export function pathAllowed(virtual: string): boolean {
  const sess = getCurrentSession()
  if (sess?.hiddenPaths == null) return true
  return !pathHidden(sess.hiddenPaths, virtual)
}

/**
 * Throw if the current session may not touch this mount. A user-defined
 * root mount is governed like any other: a session must be granted `/`
 * to touch it.
 */
export function assertMountAllowed(mountPrefix: string): void {
  if (sessionMode(mountPrefix) !== undefined) return
  const sess = getCurrentSession()
  throw new MountNotAllowedError(sess?.sessionId ?? '', normPrefix(mountPrefix))
}

/**
 * The mount mode after narrowing by the current session's cap. The
 * mount's own mode is the ceiling; the session's mode can only weaken
 * it. A mount absent from the modes map narrows to READ here; visibility denial is
 * `assertMountAllowed`'s job at the dispatch entry points.
 */
export function effectiveMountMode(mountPrefix: string, mountMode: MountMode): MountMode {
  const cap = sessionMode(mountPrefix)
  if (cap === undefined) return MountMode.READ
  return weakerMode(mountMode, cap)
}
