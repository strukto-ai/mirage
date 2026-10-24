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

import { PolicyDenied } from '../../../../policy/index.ts'
import type { FileStat, SetAttrFields } from '../../../../types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { NamespaceLinks } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { groupName, ownerName } from '../../../../commands/builtin/utils/identity.ts'
import { dispatchStat, dotRefusal } from '../../../../commands/builtin/utils/paths.ts'
import { beforeFullScan } from '../../../../commands/builtin/utils/tree.ts'
import { UsageError } from '../../../../commands/errors.ts'
import type { FlagView } from '../../../../commands/spec/flag_view.ts'
import {
  fsStrerror,
  isEacces,
  isEnoent,
  isEnotdir,
  isErofs,
  walkRefusal,
} from '../../../../errors/fs.ts'
import { fsErrorLine } from '../../../../errors/render.ts'
import { CycleError, ancestors } from '../../../../utils/path.ts'
import { shellQuoteAlways } from '../../../../utils/quote.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import { expandOperands, result } from '../shared.ts'
import type { Result } from '../types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { posixPhrase } from '../../../../errors/posix.ts'

export function parseOwner(text: string): [number | string | null, number | string | null] {
  const sep = text.indexOf(':')
  const owner = sep >= 0 ? text.slice(0, sep) : text
  const group = sep >= 0 ? text.slice(sep + 1) : ''
  const uid = owner.length > 0 ? (/^\d+$/.test(owner) ? parseInt(owner, 10) : owner) : null
  const gid =
    sep >= 0 && group.length > 0 ? (/^\d+$/.test(group) ? parseInt(group, 10) : group) : null
  return [uid, gid]
}

// Parse a chgrp GROUP argument. Numeric ids become numbers; names are kept
// as strings (mirage has no group database; ownership is stored, not
// enforced). Null when the text is empty.
export function parseGroup(text: string): number | string | null {
  if (text.length === 0) return null
  return /^\d+$/.test(text) ? parseInt(text, 10) : text
}

// Resolve touch -t/-d into an ISO timestamp. `t` is a POSIX
// `[[CC]YY]MMDDhhmm[.ss]` stamp; `d` is a date string (ISO 8601). Returns
// null when neither flag is given; throws Error when the stamp is invalid.
export function parseTouchStamp(t: string | null, d: string | null): string | null {
  if (t !== null) {
    let raw = t
    let seconds = 0
    if (raw.includes('.')) {
      const dot = raw.indexOf('.')
      const secText = raw.slice(dot + 1)
      raw = raw.slice(0, dot)
      if (secText.length !== 2 || !/^\d+$/.test(secText)) throw new Error(t)
      seconds = parseInt(secText, 10)
    }
    if (!/^\d+$/.test(raw)) throw new Error(t)
    if (raw.length === 8) {
      raw = String(new Date().getUTCFullYear()).padStart(4, '0') + raw
    } else if (raw.length === 10) {
      const century = parseInt(raw.slice(0, 2), 10) < 69 ? '20' : '19'
      raw = century + raw
    }
    if (raw.length !== 12) throw new Error(t)
    const dt = new Date(
      Date.UTC(
        parseInt(raw.slice(0, 4), 10),
        parseInt(raw.slice(4, 6), 10) - 1,
        parseInt(raw.slice(6, 8), 10),
        parseInt(raw.slice(8, 10), 10),
        parseInt(raw.slice(10, 12), 10),
        seconds,
      ),
    )
    if (Number.isNaN(dt.getTime())) throw new Error(t)
    if (
      dt.getUTCMonth() !== parseInt(raw.slice(4, 6), 10) - 1 ||
      dt.getUTCDate() !== parseInt(raw.slice(6, 8), 10) ||
      dt.getUTCHours() !== parseInt(raw.slice(8, 10), 10) ||
      dt.getUTCMinutes() !== parseInt(raw.slice(10, 12), 10) ||
      seconds > 59
    ) {
      throw new Error(t)
    }
    return isoformat(dt)
  }
  if (d !== null) {
    let normalized = d.replace('Z', '+00:00').replace(' ', 'T')
    if (!normalized.includes('T')) normalized += 'T00:00:00'
    const hasZone = /[+-]\d{2}:\d{2}$/.test(normalized)
    const dt = new Date(hasZone ? normalized : normalized + '+00:00')
    if (Number.isNaN(dt.getTime())) throw new Error(d)
    return isoformat(dt)
  }
  return null
}

// Python's `datetime.isoformat()` for a UTC instant, the spelling the Python
// touch stores: the fraction is written only when there is one, and a Date's
// milliseconds make its last three microsecond digits zero.
function isoformat(dt: Date): string {
  const ms = dt.getUTCMilliseconds()
  const fraction = ms === 0 ? '' : `.${String(ms).padStart(3, '0')}000`
  return `${dt.toISOString().slice(0, 19)}${fraction}+00:00`
}

export function nowIso(): string {
  return isoformat(new Date())
}

// A refusal, not an absence: a rule's or a policy's deny (EACCES) or a
// read-only mount (EROFS), which chmod, chown, chgrp and touch report for
// the one file and go on past. Python's twin is `except PermissionError`.
export function isRefusal(err: unknown): boolean {
  return isEacces(err) || isErofs(err)
}

// A refused attribute write. A read-only mount is GNU's per-operand line,
// `<cmd>: <action> '<name>': Read-only file system`, the voice every other
// write refusal uses; a policy's deny at the dispatcher is the line a
// refused operand gets, `<cmd>: <name>: Permission denied` (touch's
// `cannot touch '<name>'`). Either names the file the way the line does,
// never the target a link resolved to: the dispatcher's error carries the
// resolved path. `action` is GNU's phrase for the write (`cannot touch`,
// `changing permissions of`). Mirrors Python's `permission_error`.
export function permissionError(cmd: string, action: string, name: string, err: unknown): string {
  if (err instanceof PolicyDenied) return fsErrorLine(cmd, name, err)
  return `${cmd}: ${action} '${name}': ${fsStrerror(err) ?? posixPhrase('EROFS')}\n`
}

// The line for a walked directory whose listing was refused: fts's
// unreadable directory, which chmod, chown and chgrp report after the
// directory's own change and do not descend. Mirrors Python's
// `unread_error`.
export function unreadError(cmd: string, name: string, err: unknown): string {
  const strerror = fsStrerror(err) ?? posixPhrase('EACCES')
  return `${cmd}: cannot read directory ${shellQuoteAlways(name)}: ${strerror}\n`
}

// Route one attribute write through the dispatcher. The dispatcher applies what
// the backend can hold natively and stores the residual in the namespace
// overlay (dropping overlay fields the backend applied, so a stale
// overlay never shadows the fresh backend value); a VFS with no
// setattr op overlays everything. Kept as a seam so every metadata
// builtin shares one call shape.
export async function setattrVia(
  dispatch: DispatchFn,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<void> {
  await dispatch('setattr', path, [], fields as Record<string, unknown>)
}

// Setattr a link node itself (the -h family): dispatched with `nofollow`
// so the dispatcher writes the link entry's own attrs instead of the target's;
// a link has no backend inode, so the dispatcher stores them in the overlay.
export async function setattrLink(
  dispatch: DispatchFn,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<void> {
  await dispatch('setattr', path, [], { ...(fields as Record<string, unknown>), nofollow: true })
}

// A subtree as [path, stat] pairs, parents before children. Each entry's
// stat is captured during the walk because chmod's symbolic clauses (u+x)
// build on the entry's own current mode. Symlinks are skipped by name:
// the dispatcher's readdir reports them (they are namespace structure), GNU
// chmod -R changes neither a traversed link nor its referent, and the
// skip must come before the stat because stat follows a link and would
// descend through a directory link.
/**
 * Follow symlinks and stat one operand, collecting GNU's errors: the dots
 * the operand was typed with walk first, then the links, then the stat.
 * `links` is the session's link table (`Namespace.sessionLinks`). Mirrors
 * Python's resolve_operand.
 */
export async function resolveOperand(
  links: NamespaceLinks,
  dispatch: DispatchFn,
  cmd: string,
  target: PathSpec,
  errors: string[],
): Promise<[PathSpec, FileStat] | null> {
  const refusal =
    target.walkError !== null
      ? walkRefusal(target)
      : await dotRefusal(dispatchStat(dispatch), target, (v) => links.follow(v))
  if (refusal !== null) {
    errors.push(
      `${cmd}: cannot access '${target.rawPath}': ${fsStrerror(refusal) ?? posixPhrase('ENOENT')}\n`,
    )
    return null
  }
  let virtual: string
  try {
    virtual = links.follow(target.virtual)
  } catch (err) {
    if (err instanceof CycleError) {
      errors.push(`${cmd}: cannot access '${target.rawPath}': Too many levels of symbolic links\n`)
      return null
    }
    throw err
  }
  const resolved = PathSpec.fromStrPath(virtual)
  try {
    const [result] = await dispatch('stat', resolved)
    return [resolved, result as FileStat]
  } catch (err) {
    const strerror = isEnoent(err) || isEnotdir(err) ? fsStrerror(err) : null
    if (strerror !== null) {
      errors.push(`${cmd}: cannot access '${target.rawPath}': ${strerror}\n`)
      return null
    }
    throw err
  }
}

// One entry of a walked subtree: its path, its stat, and the refusal its
// listing met (null for a file, or a directory that listed).
export type WalkEntry = [PathSpec, FileStat, unknown]

// A subtree as [path, stat, unread] triples, in fts's pre-order. `links`
// is the session's link table (`Namespace.sessionLinks`). `unread` is the
// refusal a directory's listing met (a rule that denies the directory lets
// its stat through): fts's unreadable directory, which the caller reports
// after the directory's own change, and whose subtree is not walked.
// Mirrors Python's walk_stats.
export async function walkStats(
  links: NamespaceLinks,
  dispatch: DispatchFn,
  root: PathSpec,
  rootStat: FileStat,
): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = []
  // An explicit stack, so a deep tree costs no recursion: a directory's
  // children go on in reverse and come off in listing order.
  const stack: [PathSpec, FileStat][] = [[root, rootStat]]
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [path, stat] = top
    if (stat.type !== FileType.DIRECTORY) {
      entries.push([path, stat, null])
      continue
    }
    let children: unknown
    try {
      ;[children] = await dispatch('readdir', path)
    } catch (err) {
      if (!isRefusal(err)) throw err
      entries.push([path, stat, err])
      continue
    }
    entries.push([path, stat, null])
    const found: [PathSpec, FileStat][] = []
    for (const listed of children as string[]) {
      // A folder-backed readdir spells a directory child with its slash.
      const childVirtual = rstripSlash(listed)
      if (links.isLink(childVirtual)) continue
      const child = PathSpec.fromStrPath(childVirtual)
      const [childStat] = await dispatch('stat', child)
      found.push([child, childStat as FileStat])
    }
    for (const entry of found.reverse()) stack.push(entry)
  }
  return entries
}

// A subtree split into backend entries and namespace link nodes. chown and
// chgrp change a traversed symlink itself rather than its referent (POSIX
// gives -R an implicit -P), and a link is namespace state that no readdir
// can report, so the link nodes are folded back in from the session's link
// table (`Namespace.sessionLinks`), but for those under a directory whose
// listing was refused, which the walk does not descend.
export async function walkOwned(
  links: NamespaceLinks,
  dispatch: DispatchFn,
  root: PathSpec,
  rootStat: FileStat,
): Promise<{ walked: WalkEntry[]; owned: string[] }> {
  const walked = await walkStats(links, dispatch, root, rootStat)
  const unread = new Set(walked.filter(([, , err]) => err !== null).map(([p]) => p.virtual))
  // The root as well, which `ancestors` leaves out: a refused listing of `/`
  // keeps every link below it unwalked.
  const owned = links
    .linkStatsBelow(root.virtual)
    .map(([path]) => path)
    .filter((path) => !['/', ...ancestors(path)].some((dir) => unread.has(dir)))
  return { walked, owned }
}

// Which files chmod, chown and chgrp report: 'verbose' (every one),
// 'changes' (the changed ones) or null. The last of -c and -v wins.
export function verbosity(fl: FlagView): string | null {
  return fl.typedOrder('changes', 'verbose').at(-1) ?? null
}

// An entry of a walked operand as GNU names it: the operand as typed, then
// the entry's path below it.
export function walkedName(typed: string, root: PathSpec, path: PathSpec): string {
  let below = path.virtual.slice(root.virtual.replace(/\/+$/, '').length)
  if (typed.endsWith('/')) below = below.replace(/^\/+/, '')
  return typed + below
}

// Whether chown or chgrp changes a link's referent, or GNU's refusal. The
// last of -h and --dereference wins; -R implies -h, and refuses an explicit
// --dereference, which needs the -H or -L walk mirage does not offer.
export function followsLinks(cmd: string, fl: FlagView): [boolean, Result | null] {
  const last = fl.typedOrder('no_dereference', 'dereference').at(-1)
  if (!fl.asBool('recursive')) return [last !== 'no_dereference', null]
  if (last === 'dereference') {
    const stderr = `${cmd}: -R --dereference requires either -H or -L\n`
    return [false, result(cmd, { exitCode: 1, stderr })]
  }
  return [false, null]
}

// `USER:GROUP`, or the one of them given, as GNU's -v names it.
export function ownerSpec(user: string | null, group: string | null): string | null {
  if (user === null) return group
  return group === null ? user : `${user}:${group}`
}

// chown and chgrp's report for one file, as GNU 9.7 prints it.
// `status` is 'changed', 'retained' or 'failed'; `old` is null when the
// file could not be read.
export function ownerLine(
  name: string,
  status: string,
  old: [string, string] | null,
  user: string | null,
  group: string | null,
): string {
  const now = ownerSpec(user, group) ?? ''
  const was =
    old === null ? null : ownerSpec(user !== null ? old[0] : null, group !== null ? old[1] : null)
  const what = user !== null ? 'ownership' : 'group'
  const shown = shellQuoteAlways(name)
  if (status === 'changed') return `changed ${what} of ${shown} from ${String(was)} to ${now}\n`
  if (status === 'retained') return `${what} of ${shown} retained as ${now}\n`
  if (was === null) return `failed to change ${what} of ${shown} to ${now}\n`
  return `failed to change ${what} of ${shown} from ${was} to ${now}\n`
}

/**
 * Set the owner and group of every operand, the way chown and chgrp do: -R
 * walks under an implicit -P, -h changes a link itself, -v and -c report,
 * -f drops the per-file errors. Mirrors Python's change_owner.
 */
export async function changeOwner(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  cmd: string,
  fl: FlagView,
  operands: readonly PathSpec[],
  uid: number | string | null,
  gid: number | string | null,
): Promise<Result> {
  const [follow, refused] = followsLinks(cmd, fl)
  if (refused !== null) return refused
  const report = verbosity(fl)
  const identity = { profile: session.profile ?? null }
  const user = uid === null ? null : String(uid)
  const group = gid === null ? null : String(gid)
  const fields: SetAttrFields = {
    ...(uid !== null ? { uid } : {}),
    ...(gid !== null ? { gid } : {}),
  }
  const action = cmd === 'chown' ? 'changing ownership of' : 'changing group of'
  const errors: string[] = []
  const out: string[] = []
  const describe = (name: string, stat: FileStat | null, failed: boolean): void => {
    let old: [string, string] | null = null
    let same = false
    if (stat !== null) {
      old = [ownerName(stat.uid, identity), groupName(stat.gid, identity)]
      same = (uid === null || uid === stat.uid) && (gid === null || gid === stat.gid)
    }
    const status = failed ? 'failed' : same ? 'retained' : 'changed'
    if (report === 'verbose' || (report === 'changes' && status === 'changed')) {
      out.push(ownerLine(name, status, old, user, group))
    }
  }
  const own = async (path: PathSpec, name: string, link: boolean): Promise<boolean> => {
    try {
      if (link) await setattrLink(dispatch, path, fields)
      else await setattrVia(dispatch, path, fields)
      return true
    } catch (err) {
      if (!isRefusal(err)) throw err
      errors.push(permissionError(cmd, action, name, err))
      return false
    }
  }
  const ownLink = async (link: PathSpec, name: string): Promise<void> => {
    let stat: FileStat | null = null
    try {
      ;[stat] = (await dispatch('stat', link, [], { nofollow: true })) as [FileStat, unknown]
    } catch (err) {
      if (!isEnoent(err) && !isEnotdir(err)) throw err
    }
    describe(name, stat, !(await own(link, name, true)))
  }
  const links = namespace.sessionLinks(session)
  for (const target of await expandOperands(namespace, dispatch, operands)) {
    const typed = target.rawPath
    if (!follow && links.isLink(target.virtual)) {
      await ownLink(target, typed)
      continue
    }
    const found = await resolveOperand(links, dispatch, cmd, target, errors)
    if (found === null) {
      describe(typed, null, true)
      continue
    }
    const [resolved, stat] = found
    if (fl.asBool('recursive')) {
      // The mount is asked before anything changes, as for rm -r: a
      // change cut short would leave a tree that looks done.
      try {
        await beforeFullScan(dispatch, resolved, cmd)
      } catch (err) {
        if (!(err instanceof UsageError)) throw err
        errors.push(`${err.message}\n`)
        continue
      }
    }
    const { walked, owned } = fl.asBool('recursive')
      ? await walkOwned(links, dispatch, resolved, stat)
      : { walked: [[resolved, stat, null]] as WalkEntry[], owned: [] as string[] }
    for (const [path, pathStat, unread] of walked) {
      const name = walkedName(typed, resolved, path)
      describe(name, pathStat, !(await own(path, name, false)))
      if (unread !== null) errors.push(unreadError(cmd, name, unread))
    }
    for (const link of owned) {
      const linkSpec = PathSpec.fromStrPath(link)
      await ownLink(linkSpec, walkedName(typed, resolved, linkSpec))
    }
  }
  const quiet = fl.asBool('silent') || fl.asBool('quiet')
  const text = out.join('')
  return result(cmd, {
    out: text === '' ? null : encodeText(text),
    exitCode: errors.length > 0 ? 1 : 0,
    ...(quiet ? {} : { stderr: errors.join('') }),
  })
}
