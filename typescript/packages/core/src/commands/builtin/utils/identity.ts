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
import type { SessionView } from '../../../view/types.ts'
import type { CommandOpts } from '../../config.ts'

// What an owner or group column prints when nothing names one: no uid or
// gid on the entry and no profile.
export const UNKNOWN_NAME = '-'

/**
 * Who a session is: its profile, the one name POSIX renders as both owner
 * and group.
 *
 * The profile is the permission set the session acts with, so it is the
 * user `whoami` prints and the group `id` names. A backend that reports a
 * uid or gid on an entry (disk, or a `chown` held in the attr overlay) wins
 * over it, so `ls -l`, `stat %U %G` and `find -printf %u %g` all agree on
 * one rule.
 */
export interface Identity {
  readonly profile: string | null
}

/** The identity the session plane describes; absent outside a workspace. */
export function identityFrom(sessionView: SessionView | undefined): Identity {
  return { profile: sessionView?.profile() ?? null }
}

/** The identity a command invocation runs as, read off its opts. */
export function identityOf(opts: CommandOpts): Identity {
  return identityFrom(opts.sessionView)
}

/** The owner column: the entry's own uid, else the session's profile, else `-`. */
export function ownerName(
  uid: number | string | null | undefined,
  identity: Identity | null,
): string {
  if (uid !== null && uid !== undefined) return String(uid)
  return identity?.profile ?? UNKNOWN_NAME
}

/** The group column: the entry's own gid, else the session's profile, else `-`. */
export function groupName(
  gid: number | string | null | undefined,
  identity: Identity | null,
): string {
  if (gid !== null && gid !== undefined) return String(gid)
  return identity?.profile ?? UNKNOWN_NAME
}
