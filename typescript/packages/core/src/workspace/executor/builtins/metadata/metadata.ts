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

import { readdirOp } from '../../../../commands/builtin/generic/crossmount/utils.ts'
import { dispatchedReadTree } from '../../../../commands/builtin/generic_bind/files.ts'
import { groupName, ownerName } from '../../../../commands/builtin/utils/identity.ts'
import { dispatchStat, dotRefusal } from '../../../../commands/builtin/utils/paths.ts'
import { beforeFullWalk, treeWalk } from '../../../../commands/builtin/utils/tree.ts'
import { UsageError } from '../../../../commands/errors.ts'
import type { FlagView } from '../../../../commands/spec/flag_view.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { callerSignal } from '../../../../context/session_context.ts'
import {
  fsStrerror,
  isEacces,
  isEnoent,
  isEnotdir,
  isFsError,
  isRefusal,
  walkRefusal,
} from '../../../../errors/fs.ts'
import { posixPhrase } from '../../../../errors/posix.ts'
import { fsErrorLine } from '../../../../errors/render.ts'
import { PolicyDenied } from '../../../../policy/index.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { FileStat, SetAttrFields } from '../../../../types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import { systemDate } from '../../../../utils/clock.ts'
import { ancestors, CycleError } from '../../../../utils/path.ts'
import { shellQuoteAlways } from '../../../../utils/quote.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import type { MountView, NamespaceLinks } from '../../../../view/types.ts'
import type { NamespaceReader } from '../../../dispatcher/reader.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { expandOperands, result } from '../shared.ts'

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
      raw = String(systemDate().getUTCFullYear()).padStart(4, '0') + raw
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
  return isoformat(systemDate())
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

/**
 * Follow symlinks for one operand, collecting the ELOOP error. `action`
 * words the step that failed (`cannot access`, `cannot touch`, `setting
 * times of`). Mirrors Python's follow_operand.
 */
export function followOperand(
  links: NamespaceLinks,
  cmd: string,
  action: string,
  target: PathSpec,
  errors: string[],
): PathSpec | null {
  let virtual: string
  try {
    virtual = links.follow(target.virtual)
  } catch (err) {
    if (err instanceof CycleError) {
      errors.push(`${cmd}: ${action} '${target.rawPath}': Too many levels of symbolic links\n`)
      return null
    }
    throw err
  }
  return PathSpec.fromStrPath(virtual)
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
  const resolved = followOperand(links, cmd, 'cannot access', target, errors)
  if (resolved === null) return null
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

// Ask the mount of `root`, and every mount below it, before -R changes
// anything, as for rm -r: a change cut short would leave a tree that looks
// done. The walk crosses into each mount below, so each one may refuse. A
// folder the session is refused is not asked: the walk does not enter it
// either, and reports it itself. Mirrors Python's before_recursive_change.
export async function beforeRecursiveChange(
  mounts: MountView,
  dispatch: DispatchFn,
  root: PathSpec,
  cmd: string,
): Promise<void> {
  for (const virtual of [root.virtual, ...mounts.visibleDescendants(root.virtual)]) {
    try {
      await beforeFullWalk(dispatch, PathSpec.fromStrPath(virtual), cmd)
    } catch (err) {
      if (!isEacces(err)) throw err
      console.debug(`walk guard skipped at ${virtual}: ${String(err)}`)
    }
  }
}

// One entry of a walked subtree: its path, its stat, and the refusal its
// listing met (null for a file, or a directory that listed).
export type WalkEntry = [PathSpec, FileStat, unknown]

// A subtree as [path, stat, unread] triples, in fts's pre-order, each stat
// read off the mount's `readTree` where one answers for the subtree. `links`
// is the session's link table (`Namespace.sessionLinks`). A traversed link is
// an entry of its own, with its own stat, and is neither changed nor
// descended: GNU chmod -R changes neither a traversed link nor its referent,
// and chown -R changes the link itself. Under -L (`follow`) the link is
// followed instead: its referent is the entry, named by the link, and a
// directory it names is walked unless the branch already holds it, as fts
// refuses a cycle. `unread` is the refusal a directory's listing met (a rule
// that denies the directory lets its stat through): fts's unreadable
// directory, which the caller reports after the directory's own change, and
// whose subtree is not walked. Mirrors Python's walk_stats.
export async function walkStats(
  links: NamespaceReader,
  dispatch: DispatchFn,
  root: PathSpec,
  rootStat: FileStat,
  follow = false,
): Promise<WalkEntry[]> {
  const plainStat = async (path: PathSpec): Promise<FileStat> =>
    (await dispatch('stat', path))[0] as FileStat
  const [readdir, statOf] = follow
    ? [readdirOp(dispatch), plainStat]
    : treeWalk<string[], FileStat>(
        dispatchedReadTree(dispatch, links.mounts(false), null, true),
        readdirOp(dispatch),
        plainStat,
        true,
        callerSignal(),
      )
  const entries: WalkEntry[] = []
  // An explicit stack, so a deep tree costs no recursion: a directory's
  // children go on in reverse and come off in listing order. Each item carries
  // the directories its branch has entered, which -L will not enter again.
  const stack: [PathSpec, FileStat, ReadonlySet<string>][] = [
    [root, rootStat, new Set([root.virtual])],
  ]
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [path, stat, branch] = top
    if (stat.type !== FileType.DIRECTORY) {
      entries.push([path, stat, null])
      continue
    }
    let children: string[]
    try {
      children = await readdir(path)
    } catch (err) {
      if (!isRefusal(err)) throw err
      entries.push([path, stat, err])
      continue
    }
    entries.push([path, stat, null])
    const found: [PathSpec, FileStat, ReadonlySet<string>][] = []
    for (const listed of children) {
      // A folder-backed readdir spells a directory child with its slash; a
      // child is named below the path walked, which under -L may be a link's
      // name.
      const bare = rstripSlash(listed)
      const name = bare.slice(bare.lastIndexOf('/') + 1)
      const child = PathSpec.fromStrPath(`${rstripSlash(path.virtual)}/${name}`)
      if (!links.isLink(bare) && !(follow && links.isLink(child.virtual))) {
        const real = follow ? links.follow(child.virtual) : child.virtual
        found.push([child, await statOf(child), new Set([...branch, real])])
        continue
      }
      if (!follow) {
        const [own] = (await dispatch('stat', child, [], { nofollow: true })) as [FileStat, unknown]
        found.push([child, own, branch])
        continue
      }
      let real: string
      let target: FileStat
      try {
        real = links.follow(child.virtual)
        target = await statOf(child)
      } catch (err) {
        if (err instanceof CycleError || isEnoent(err) || isEnotdir(err)) continue
        throw err
      }
      if (!branch.has(real)) found.push([child, target, new Set([...branch, real])])
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
  links: NamespaceReader,
  dispatch: DispatchFn,
  root: PathSpec,
  rootStat: FileStat,
): Promise<{ walked: WalkEntry[]; owned: string[] }> {
  const walked = (await walkStats(links, dispatch, root, rootStat)).filter(
    ([, stat]) => stat.type !== FileType.SYMLINK,
  )
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

// How -R treats links, the last of -H (follow an operand), -L (follow every
// one) and -P (follow none); `fallback` is the walk with none of them: H for
// chmod, P for chown and chgrp. Mirrors Python's traversal.
export function traversal(fl: FlagView, fallback: string): string {
  return fl.typedOrder('H', 'L', 'P').at(-1) ?? fallback
}

// Whether chown or chgrp changes an operand link's referent, or GNU's
// refusal. The last of -h and --dereference wins. -R walks under -P unless -H
// or -L says otherwise: -P changes an operand link itself and refuses an
// explicit --dereference, and -H and -L follow it. Mirrors Python's
// follows_links.
export function followsLinks(cmd: string, fl: FlagView): [boolean, RedirectResult | null] {
  const last = fl.typedOrder('no_dereference', 'dereference').at(-1)
  if (!fl.asBool('recursive')) return [last !== 'no_dereference', null]
  if (traversal(fl, 'P') !== 'P') return [true, null]
  if (last === 'dereference') {
    const stderr = `${cmd}: -R --dereference requires either -H or -L\n`
    return [false, result(cmd, { exitCode: 1, stderr })]
  }
  return [false, null]
}

// --preserve-root's refusal of a -R walk from `/`, or null. The last of
// --preserve-root and --no-preserve-root wins, and none walks. Mirrors
// Python's root_refusal.
export function rootRefusal(
  cmd: string,
  fl: FlagView,
  typed: string,
  resolved: PathSpec,
): string | null {
  const last = fl.typedOrder('preserve_root', 'no_preserve_root').at(-1)
  if (last !== 'preserve_root' || resolved.virtual.replace(/\//g, '') !== '') return null
  const same = typed === '/' ? '' : " (same as '/')"
  return (
    `${cmd}: it is dangerous to operate recursively on ${shellQuoteAlways(typed)}${same}\n` +
    `${cmd}: use --no-preserve-root to override this failsafe\n`
  )
}

// The stat --reference copies from, link-followed, or GNU's refusal, exit 1.
// Mirrors Python's reference_stat.
export async function referenceStat(
  links: NamespaceLinks,
  dispatch: DispatchFn,
  cmd: string,
  reference: PathSpec,
): Promise<FileStat | RedirectResult> {
  try {
    const [stat] = await dispatch('stat', PathSpec.fromStrPath(links.follow(reference.virtual)))
    return stat as FileStat
  } catch (err) {
    if (!(err instanceof CycleError) && !isFsError(err)) throw err
    const named = shellQuoteAlways(reference.rawPath)
    const stderr = `${cmd}: failed to get attributes of ${named}: ${fsStrerror(err) ?? ''}\n`
    return result(cmd, { exitCode: 1, stderr })
  }
}

// The files a --reference line changes: the word a mode or an owner would
// take is a file too. Mirrors Python's reference_operands.
export function referenceOperands(
  texts: readonly string[],
  paths: readonly PathSpec[],
  cwd: string,
): PathSpec[] {
  return [...texts.map((text) => PathSpec.fromStrPath(text, undefined, cwd)), ...paths]
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
  current: [number | string | null, number | string | null] | null = null,
): Promise<RedirectResult> {
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
  const matches = (stat: FileStat | null): boolean =>
    current === null ||
    stat === null ||
    ((current[0] === null || String(current[0]) === String(stat.uid)) &&
      (current[1] === null || String(current[1]) === String(stat.gid)))
  const describe = (name: string, stat: FileStat | null, failed: boolean): void => {
    let old: [string, string] | null = null
    let same = false
    if (stat !== null && !matches(stat)) {
      if (report === 'verbose') out.push(ownerLine(name, 'retained', null, user, group))
      return
    }
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
    describe(name, stat, matches(stat) && !(await own(link, name, true)))
  }
  const ownReferent = async (link: PathSpec, name: string): Promise<void> => {
    let stat: FileStat
    try {
      ;[stat] = (await dispatch('stat', link)) as [FileStat, unknown]
    } catch (err) {
      if (!isEnoent(err) && !isEnotdir(err)) throw err
      errors.push(
        `${cmd}: cannot dereference ${shellQuoteAlways(name)}: ${fsStrerror(err) ?? ''}\n`,
      )
      return
    }
    describe(name, stat, matches(stat) && !(await own(link, name, false)))
  }
  // Under -H or -L a link the walk meets is changed through, unless -h asks
  // for the link itself.
  const through =
    traversal(fl, 'P') !== 'P' &&
    fl.typedOrder('no_dereference', 'dereference').at(-1) !== 'no_dereference'
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
      const refusal = rootRefusal(cmd, fl, typed, resolved)
      if (refusal !== null) {
        errors.push(refusal)
        continue
      }
      try {
        await beforeRecursiveChange(links.mounts(false), dispatch, resolved, cmd)
      } catch (err) {
        if (!(err instanceof UsageError)) throw err
        errors.push(`${err.message}\n`)
        continue
      }
    }
    const { walked, owned } = !fl.asBool('recursive')
      ? { walked: [[resolved, stat, null]] as WalkEntry[], owned: [] as string[] }
      : traversal(fl, 'P') === 'L'
        ? { walked: await walkStats(links, dispatch, resolved, stat, true), owned: [] as string[] }
        : await walkOwned(links, dispatch, resolved, stat)
    for (const [path, pathStat, unread] of walked) {
      const name = walkedName(typed, resolved, path)
      describe(name, pathStat, matches(pathStat) && !(await own(path, name, false)))
      if (unread !== null) errors.push(unreadError(cmd, name, unread))
    }
    for (const link of owned) {
      const linkSpec = PathSpec.fromStrPath(link)
      const name = walkedName(typed, resolved, linkSpec)
      if (through) await ownReferent(linkSpec, name)
      else await ownLink(linkSpec, name)
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
