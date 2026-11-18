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
import type { Ids } from '../../../core/generic/types.ts'
import { idNumber } from '../../../utils/stat_view.ts'
import type { SessionView } from '../../../view/types.ts'
import type { Context } from '../../config.ts'

// What a column prints for a fact nothing reports, such as another
// session's owner in ps.
export const UNKNOWN_NAME = '-'

// What stat prints for an id the user database holds no name for.
export const UNKNOWN_ID_NAME = 'UNKNOWN'

const ROOT_ID = 0
// The first id Debian's adduser hands a person, which a profile's user
// holds.
const USER_ID = 1000
// The id the kernel maps an unknown owner to (overflowuid).
const NOBODY_ID = 65534

// The home bash's `~` names for a uid the user database does not hold.
const NO_HOME = '/'
// Where Debian's adduser puts a person's home.
const HOME_BASE = '/home'

/** One user the session's user database holds, as an `/etc/passwd` row names it. */
export interface Account {
  readonly name: string
  readonly uid: number
  readonly group: string
  readonly gid: number
  readonly home: string
}

export const ROOT: Account = {
  name: 'root',
  uid: ROOT_ID,
  group: 'root',
  gid: ROOT_ID,
  home: '/root',
}
export const NOBODY: Account = {
  name: 'nobody',
  uid: NOBODY_ID,
  group: 'nogroup',
  gid: NOBODY_ID,
  home: '/nonexistent',
}

/**
 * Who a session is, read off its profile, as Linux reads a process's user
 * off its uid.
 *
 * A session with no profile is root, uid 0: nothing restricts it, as
 * nothing restricts uid 0. A named profile is a user of that name with uid
 * and gid 1000, the first an installer hands a person, unless the name is
 * one the database already holds (`root`, `nobody`). A profile document
 * passed without a name is uid 1000 with no entry in the database, so
 * `whoami` cannot name it, as Linux cannot name a uid missing from
 * `/etc/passwd`. A backend that reports an owner on an entry (disk, a
 * machine, or a `chown` the attr overlay holds) wins over the session's, so
 * `ls -l`, `stat` and `find` agree on one rule.
 *
 * `profile` is null for a session with no profile, empty for a document
 * passed without a name.
 */
export interface Identity {
  readonly profile: string | null
}

/** The identity the session plane describes; root outside a workspace. */
export function identityFrom(sessionView: SessionView | undefined): Identity {
  return { profile: sessionView?.profile() ?? null }
}

/** The identity a command invocation runs as, read off its ctx. */
export function identityOf(ctx: Context): Identity {
  return identityFrom(ctx.session)
}

/** The session's own row in the user database, null for a document passed without a name. */
export function ownAccount(identity: Identity | null): Account | null {
  const profile = identity?.profile ?? null
  if (profile === null) return ROOT
  if (profile === '') return null
  for (const held of [ROOT, NOBODY]) {
    if (held.name === profile) return held
  }
  return {
    name: profile,
    uid: USER_ID,
    group: profile,
    gid: USER_ID,
    home: `${HOME_BASE}/${profile}`,
  }
}

/** The session's user database: root, nobody and the session's own user. */
export function accounts(identity: Identity | null): readonly Account[] {
  const own = ownAccount(identity)
  if (own === null || own === ROOT || own === NOBODY) return [ROOT, NOBODY]
  return [ROOT, NOBODY, own]
}

/** The uid the session runs as. */
export function sessionUid(identity: Identity | null): number {
  return ownAccount(identity)?.uid ?? USER_ID
}

/** The gid the session runs as. */
export function sessionGid(identity: Identity | null): number {
  return ownAccount(identity)?.gid ?? USER_ID
}

/** The home directory bash's `~` names when `HOME` is unset. */
export function homeOf(identity: Identity | null): string {
  return ownAccount(identity)?.home ?? NO_HOME
}

/** Each user's home, which bash's `~name` names. */
export function userHomes(identity: Identity | null): Record<string, string> {
  return Object.fromEntries(accounts(identity).map((account) => [account.name, account.home]))
}

/** The user a name names, as `groups` looks one up: by name only. */
export function userNamed(identity: Identity | null, name: string): Account | null {
  return accounts(identity).find((account) => account.name === name) ?? null
}

/**
 * The user a name or a number names, as `id` and `chown` look one up: by
 * name first, then by uid when the text is a number.
 */
export function findUser(identity: Identity | null, text: string): Account | null {
  const named = userNamed(identity, text)
  if (named !== null) return named
  const number = idNumber(text)
  return number === null ? null : userWithId(identity, number)
}

/** The user a uid belongs to, null for a uid the database lacks. */
function userWithId(identity: Identity | null, uid: number): Account | null {
  return accounts(identity).find((account) => account.uid === uid) ?? null
}

/** The gid a group name names, null for a name the database lacks. */
export function groupIdNamed(identity: Identity | null, name: string): number | null {
  return accounts(identity).find((account) => account.group === name)?.gid ?? null
}

/** The name of the group a gid is, null for a gid the database lacks. */
export function groupWithId(identity: Identity | null, gid: number): string | null {
  return accounts(identity).find((account) => account.gid === gid)?.group ?? null
}

/**
 * The owner's uid: the entry's own, else the session's. A name a backend
 * reports (a machine names its owners) maps through the database, and stays
 * a name where the database lacks it.
 */
export function ownerId(uid: number | string | null, identity: Identity | null): number | string {
  if (uid === null) return sessionUid(identity)
  if (typeof uid === 'number') return uid
  return idNumber(uid) ?? userNamed(identity, uid)?.uid ?? uid
}

/** The group's gid, read as `ownerId` reads the owner's. */
export function groupId(gid: number | string | null, identity: Identity | null): number | string {
  if (gid === null) return sessionGid(identity)
  if (typeof gid === 'number') return gid
  return idNumber(gid) ?? groupIdNamed(identity, gid) ?? gid
}

/** The owner's name, null for a uid the database holds no name for. */
export function ownerName(uid: number | string | null, identity: Identity | null): string | null {
  const number = ownerId(uid, identity)
  if (typeof number === 'string') return number
  return userWithId(identity, number)?.name ?? null
}

/** The group's name, null for a gid the database holds no name for. */
export function groupName(gid: number | string | null, identity: Identity | null): string | null {
  const number = groupId(gid, identity)
  if (typeof number === 'string') return number
  return groupWithId(identity, number)
}

/** The owner column `ls -l` prints: the name, else the number. */
export function ownerLabel(uid: number | string | null, identity: Identity | null): string {
  return ownerName(uid, identity) ?? String(ownerId(uid, identity))
}

/** The group column `ls -l` prints: the name, else the number. */
export function groupLabel(gid: number | string | null, identity: Identity | null): string {
  return groupName(gid, identity) ?? String(groupId(gid, identity))
}

/** The user database as `find` reads it. */
export function findIds(identity: Identity | null): Ids {
  const held = accounts(identity)
  return {
    users: Object.fromEntries(held.map((account) => [account.name, account.uid])),
    groups: Object.fromEntries(held.map((account) => [account.group, account.gid])),
    uid: sessionUid(identity),
    gid: sessionGid(identity),
  }
}
