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

import { FileType, LINK_TARGET_KEY, PathSpec } from '../../../../types.ts'
import type { FileStat } from '../../../../types.ts'
import { parent, posixNormpath } from '../../../../utils/path.ts'
import { isMissingPath } from '../../../../utils/errors.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { LinkView, MountView, StatPath } from '../../../../ops/types.ts'
import { PERMISSION_BITS, SYMLINK_MODE } from './constants.ts'
import { MountInWayError } from './errors.ts'
import { basename } from './path.ts'
import type { Dispatch } from './types.ts'

/** Read one virtual path through the workspace dispatcher. */
export async function readFile(dispatch: Dispatch, path: string): Promise<Uint8Array> {
  const [data] = await dispatch('read', PathSpec.fromStrPath(path))
  return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
}

/**
 * The bytes git stores for one working-tree entry.
 *
 * A symlink's blob is its target string, not what the target holds, so reading
 * through the link would stage a second copy of the target under mode 100644
 * and then report the entry modified forever after (the staged blob and the
 * bytes behind the link never match). The target is namespace state, which is
 * why it arrives on the stat rather than from a read.
 */
export async function entryBytes(
  dispatch: Dispatch,
  path: string,
  info: FileStat,
): Promise<Uint8Array> {
  if (info.type === FileType.SYMLINK) {
    const target = info.extra[LINK_TARGET_KEY]
    if (typeof target === 'string') return new TextEncoder().encode(target)
  }
  return readFile(dispatch, path)
}

/**
 * Materialize one tree entry into the working tree.
 *
 * A 120000 entry is a symlink whose blob is the target string, so it is
 * restored through the namespace rather than written as content: writing the
 * blob would leave a regular file spelling the target.
 *
 * Whatever is already there goes first, whichever kind it is, because git
 * replaces a tree entry rather than merging with it. Two of the four
 * combinations are the ones that corrupt state: writing a regular blob at a
 * path the namespace holds a link for follows the link and lands the content in
 * the file it points at, damaging a path no branch touched while the link
 * stays; and linking over a regular file leaves that file behind the link,
 * ready to reappear when the link goes. The fourth, a link over a link, is the
 * retarget a checkout does when a branch moves where a link points: symlink(2)
 * does not overwrite, so the old name is removed rather than replaced in place.
 * The check is a namespace lookup, so the ordinary file-for-file case costs
 * nothing.
 *
 * The permission bits are part of the entry, not decoration on it. git records
 * exactly one of them, the owner's execute bit, and puts it back in both
 * directions: `chmod -x` on a `100755` path is a modification `restore` undoes,
 * and `chmod +x` on a `100644` one is a modification it undoes the other way.
 * Writing the bytes alone left the bit as the working tree had it, so the file
 * came back unrunnable and `status` went on calling it modified for ever. The
 * write is unconditional rather than probed: a stat to decide costs the same op
 * as the setattr it would save, and the backends git actually runs on apply it
 * natively, so nothing reaches the overlay.
 */
export async function restoreEntry(
  dispatch: Dispatch,
  path: string,
  mode: string,
  blob: Uint8Array,
  links: LinkView | null = null,
): Promise<void> {
  const linked = links !== null && links.statAt(path) !== null
  if (mode === SYMLINK_MODE) {
    await removeFile(dispatch, path)
    await dispatch('symlink', PathSpec.fromStrPath(path), [], {
      target: new TextDecoder().decode(blob),
    })
    return
  }
  if (linked) await removeFile(dispatch, path)
  await writeFile(dispatch, path, blob)
  await dispatch('setattr', PathSpec.fromStrPath(path), [], {
    mode: Number.parseInt(mode, 8) & PERMISSION_BITS,
  })
}

/**
 * Leave a submodule's working tree alone, but make sure it has one.
 *
 * A 160000 entry names a commit in another repository, which this one does not
 * hold: reading it as a blob is either a miss (an ordinary submodule keeps its
 * objects in its own store) or, when the id does happen to resolve here, an
 * empty string written over the directory. git does neither. It checks out no
 * submodule content at all without `--recurse-submodules`, and all the entry
 * asks of the working tree is that a directory stand at the name: an existing
 * one is left exactly as it is, untracked work included, a regular file or a
 * link is replaced by an empty one, and a missing one is created. Pinned
 * against git 2.50.1.
 *
 * @param dispatch workspace op dispatcher
 * @param statPath the data plane's stat, which dereferences
 * @param path absolute virtual path of the submodule
 * @param links the name plane's link facts, null when no namespace is wired
 */
export async function keepGitlink(
  dispatch: Dispatch,
  statPath: StatPath,
  path: string,
  links: LinkView | null,
): Promise<void> {
  const linked = (links?.statAt(path) ?? null) !== null
  const info = linked ? null : await statPath(path)
  if (info !== null && info.type === FileType.DIRECTORY) return
  if (linked || info !== null) await removeFile(dispatch, path)
  await ensureDir(dispatch, path)
}

/**
 * Take a submodule's directory away, or say why it stays.
 *
 * The other direction of `keepGitlink`, and it is not an unlink: what stands at
 * a 160000 entry is a directory, so git calls `rmdir` and warns rather than
 * failing when that cannot be done. An empty one goes; one still holding a
 * checked-out submodule, or anything else untracked, stays and is named; a
 * regular file or a link at the name is the `ENOTDIR` wording of the same
 * warning; a name with nothing at it is silent. The switch itself succeeds
 * either way, which is the whole point of warning instead of throwing. Pinned
 * against git 2.50.1.
 *
 * @param dispatch workspace op dispatcher
 * @param statPath the data plane's stat, which dereferences
 * @param path absolute virtual path of the submodule
 * @param name the path as git prints it, repository-relative
 * @param links the name plane's link facts, null when no namespace is wired
 * @returns the warning line to write, null when there is nothing to say
 */
export async function dropGitlink(
  dispatch: Dispatch,
  statPath: StatPath,
  path: string,
  name: string,
  links: LinkView | null,
): Promise<string | null> {
  // A link is answered before the stat, which dereferences: rmdir never follows
  // one, so a link to a directory is ENOTDIR here even though stat would call
  // it a directory.
  if ((links?.statAt(path) ?? null) !== null) {
    return `warning: unable to rmdir '${name}': Not a directory\n`
  }
  const info = await statPath(path)
  if (info === null) return null
  if (info.type !== FileType.DIRECTORY) {
    return `warning: unable to rmdir '${name}': Not a directory\n`
  }
  if ((await readNames(dispatch, path)).length > 0) {
    return `warning: unable to rmdir '${name}': Directory not empty\n`
  }
  await dispatch('rmdir', PathSpec.fromStrPath(path))
  return null
}

/** Read a byte range of one virtual path. */
export async function readRange(
  dispatch: Dispatch,
  path: string,
  offset: number,
  size: number,
): Promise<Uint8Array> {
  const [data] = await dispatch('read', PathSpec.fromStrPath(path), [], { offset, size })
  return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
}

/**
 * Read a path that a repository may legitimately not have.
 *
 * `packed-refs` and `HEAD`-adjacent files are absent in perfectly valid
 * repositories, so a miss is an answer rather than an error.
 */
export async function readOptional(dispatch: Dispatch, path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(dispatch, path)
  } catch (err) {
    if (isMissingPath(err)) return null
    throw err
  }
}

/** List a directory, empty when it does not exist. */
export async function readNames(dispatch: Dispatch, path: string): Promise<string[]> {
  try {
    const [entries] = await dispatch('readdir', PathSpec.fromStrPath(path))
    return [...((entries as string[] | null) ?? [])]
  } catch (err) {
    if (isMissingPath(err)) return []
    throw err
  }
}

/**
 * Create a directory and every missing directory above it.
 *
 * Written out rather than delegated to `mkdir -p` because the parents flag is a
 * per-backend capability: the ops factory only wires `parents: true` for
 * backends that declare it, so a plain `mkdir` of `objects/ab` fails on the
 * rest.
 *
 * Existence is probed with a point stat, which on a prefix store misses a
 * directory that has no object of its own. That false negative is harmless here
 * and the reason this does not need the two-channel stat: on such a store a
 * directory is the set of keys under it, so creating one again costs a no-op
 * rather than an error.
 */
export async function ensureDir(dispatch: Dispatch, path: string): Promise<void> {
  const missing: string[] = []
  let current = path.replace(/\/+$/, '')
  while (current !== '' && current !== '/') {
    try {
      await dispatch('stat', PathSpec.fromStrPath(current))
      break
    } catch (err) {
      if (!isMissingPath(err)) throw err
      missing.push(current)
      current = parent(current)
    }
  }
  for (const target of missing.reverse()) {
    await dispatch('mkdir', PathSpec.fromStrPath(target))
  }
}

/**
 * Whether a path names a directory, false when nothing is there.
 *
 * Asked with a stat rather than inferred from a failed read: a read of a
 * directory misses on a keyed store and raises EISDIR on disk, so "the read did
 * not work" says nothing about what the path is.
 */
export async function isDirectory(dispatch: Dispatch, path: string): Promise<boolean> {
  try {
    const [stat] = await dispatch('stat', PathSpec.fromStrPath(path))
    return (stat as { type?: string } | null)?.type === FileType.DIRECTORY
  } catch (err) {
    if (isMissingPath(err)) return false
    throw err
  }
}

/** Whether a point lookup finds anything at a path. */
export async function exists(dispatch: Dispatch, path: string): Promise<boolean> {
  try {
    await dispatch('stat', PathSpec.fromStrPath(path))
  } catch (err) {
    if (isMissingPath(err)) return false
    throw err
  }
  return true
}

/** Write one virtual path, creating the directories above it. */
export async function writeFile(dispatch: Dispatch, path: string, data: Uint8Array): Promise<void> {
  await ensureDir(dispatch, parent(path))
  await dispatch('write', PathSpec.fromStrPath(path), [data])
}

/**
 * Delete one virtual path, tolerating one that is already gone.
 *
 * A miss is an answer rather than an error for every caller here: unstaging a
 * path deletes whatever ref or lock may or may not exist, and a checkout removes
 * files the other branch does not have.
 */
export async function removeFile(dispatch: Dispatch, path: string): Promise<void> {
  try {
    await dispatch('unlink', PathSpec.fromStrPath(path))
  } catch (err) {
    if (!isMissingPath(err)) throw err
  }
}

/** Join path segments below a git directory, POSIX style. */
export function under(base: string, ...parts: string[]): string {
  return posixNormpath(`${base}/${parts.join('/')}`)
}

/**
 * The nearest component above an entry that is not a directory.
 *
 * An entry's path is only a way through the working tree while every component
 * above it is a directory. Anything else standing on one -- a symlink, a
 * regular file, tracked or not -- is not a way through, and the two directions
 * take it differently. Writing the entry *replaces* it with the directory the
 * entry needs, leaving whatever a link pointed at exactly as it was; removing
 * the entry does nothing at all, because the path never led there. That is
 * git's `create_directories` and `check_leading_path`, and both halves were
 * probed against git 2.50.1.
 *
 * The namespace is asked before the data plane, and the order is the whole
 * point: `statPath` dereferences, so a link to a directory stats as a directory
 * and the walk would carry on straight through it. Only the name plane can say
 * that the component is a link.
 *
 * An exact-path lookup cannot see any of this, since what is in the way sits
 * above the name being looked up rather than on it.
 *
 * @param statPath the data plane's stat, which dereferences
 * @param worktree absolute virtual path of the working tree root
 * @param name the entry, repository-relative
 * @param links the name plane's link facts, null when no namespace is wired
 * @returns the absolute virtual path of the nearest such component, null when
 *   every component above the entry is a directory
 */
export async function blockingAncestor(
  statPath: StatPath,
  worktree: string,
  name: string,
  links: LinkView | null,
): Promise<string | null> {
  let current = worktree
  for (const part of name.split('/').slice(0, -1)) {
    current = under(current, part)
    if ((links?.statAt(current) ?? null) !== null) return current
    const info = await statPath(current)
    if (info !== null && info.type !== FileType.DIRECTORY) return current
  }
  return null
}

/**
 * Move one virtual path, file or directory, to another name.
 *
 * The mount's own rename, so a directory moves with everything under it,
 * tracked or not, which is what `git mv` does with a directory. The
 * destination's directory is not created: git's rename fails when it is
 * missing, and the caller words that failure.
 */
export async function renamePath(
  dispatch: Dispatch,
  source: string,
  target: string,
): Promise<void> {
  await dispatch('rename', PathSpec.fromStrPath(source), [PathSpec.fromStrPath(target)])
}

/**
 * Ask of every destination first what the write loop would meet later.
 *
 * `removeTree` refuses a directory holding a mount, but the loop reaches one
 * entry at a time, so a refusal there leaves the entries already written
 * standing on the target's content with HEAD and the index still where they
 * were. Asking first is the shape every other collision check in these verbs
 * already has: name what is in the way and change nothing. The condition
 * mirrors the write loop's exactly, a link included, so a destination the loop
 * would not clear is not refused here either.
 *
 * @param statPath the data plane's stat, which dereferences
 * @param worktree absolute virtual path of the working tree root
 * @param names repository-relative paths about to be written
 * @param links the name plane's link facts, null when no namespace is wired
 * @param mounts the name plane's mount boundaries, null when none is wired
 */
export async function refuseReplacedMounts(
  statPath: StatPath,
  worktree: string,
  names: readonly string[],
  links: LinkView | null,
  mounts: MountView | null,
): Promise<void> {
  if (mounts === null) return
  for (const name of [...names].sort(compareCodePoints)) {
    const where = under(worktree, name)
    if ((links?.statAt(where) ?? null) !== null) continue
    const info = await statPath(where)
    if (info !== null && info.type === FileType.DIRECTORY) refuseMount(mounts, where)
  }
}

/**
 * Refuse a removal that would take a nested mount with it.
 *
 * A mount nested inside the working tree is served by another resource, and
 * `readdir` merges it into the parent's listing, so a walk that empties a
 * directory walks straight into the child backend and unlinks what is in it.
 * No branch ever recorded any of that, and the `rmdir` that follows takes the
 * mount root itself. Asking the mount table is the only way to see the
 * boundary: the parent backend cannot.
 *
 * Two questions, two fields, the way `MountView` says: the boundary is
 * *avoided* by the unfiltered list, so a mount this session cannot see still
 * blocks the removal, and it is *named* from the visible one, since naming a
 * hidden mount is what the hide exists to prevent.
 *
 * @param mounts the name plane's mount boundaries, null when none is wired
 * @param path absolute virtual path about to be removed
 */
export function refuseMount(mounts: MountView | null, path: string): void {
  if (mounts === null) return
  if (mounts.isRoot(path)) throw new MountInWayError(path, path)
  if (mounts.descendants(path).length === 0) return
  const named = [...mounts.visibleDescendants(path)].sort(compareCodePoints)
  throw new MountInWayError(path, named[0] ?? null)
}

/**
 * Delete a path and everything under it, tracked or not.
 *
 * git replaces a tree entry rather than merging with it, so a directory
 * standing where the source keeps a file goes entirely. That is one of the few
 * places git removes a file it never tracked: an untracked child keeps the
 * directory alive after the tracked ones are gone, and restoring the file over
 * it would otherwise fail with the index already changed.
 *
 * A file and an absent path both walk out through the same two steps, since
 * `readdir` reads a non-directory as nothing there and `rmdir` refuses it.
 *
 * A child that is a symlink is unlinked, never descended into. The name plane
 * has to say so, because `readdir` dereferences: a link to a directory lists
 * that directory's contents, and recursing on them deletes a tree outside the
 * one being replaced. `rm -r` does not follow a link either, so a branch
 * recording a file where the working tree has a directory takes the link away
 * with the directory and leaves whatever it pointed at exactly as it was.
 * Pinned against git 2.50.1.
 *
 * @param dispatch workspace op dispatcher
 * @param path absolute virtual path to clear
 * @param links the name plane's link facts, null when no namespace is wired
 * @param mounts the name plane's mount boundaries, null when none is wired
 */
export async function removeTree(
  dispatch: Dispatch,
  path: string,
  links: LinkView | null,
  mounts: MountView | null,
): Promise<void> {
  // Before the first deletion rather than at the boundary itself, so a mount
  // deep under the directory costs the caller nothing: the scan sees every
  // depth at once and the tree is still whole when it refuses.
  refuseMount(mounts, path)
  let entries: string[] = []
  try {
    entries = await readNames(dispatch, path)
  } catch (err) {
    // `readNames` reads only an absent path as nothing there, where python's
    // `read_names` folds "not a directory" in as well (MISS_ERRORS carries
    // NotADirectoryError). A file listed as a directory is exactly what this
    // walk expects to meet, and the unlink below is its answer.
    if ((err as { code?: string }).code !== 'ENOTDIR') throw err
  }
  for (const entry of entries) {
    // A listing answers in whole paths, so the child is rebuilt from the
    // basename the way every other walk here does.
    const name = basename(entry)
    if (name === '') continue
    const child = under(path, name)
    if ((links?.statAt(child) ?? null) !== null) {
      await removeFile(dispatch, child)
      continue
    }
    await removeTree(dispatch, child, links, mounts)
  }
  try {
    await dispatch('rmdir', PathSpec.fromStrPath(path))
  } catch (err) {
    // A directory the walk above was supposed to empty is a real failure and
    // stays thrown. Everything else means this was no directory (or is
    // already gone), so the path is whatever one file it is and unlink
    // tolerates an absent one.
    if ((err as { code?: string }).code === 'ENOTEMPTY') throw err
    await removeFile(dispatch, path)
  }
}

/**
 * Drop the directories a deletion left empty, up to a root.
 *
 * git removes a directory the moment its last tracked file is deleted or
 * restored away, so `rm -r docs` leaves no `docs/` behind. The walk stops at the
 * first directory that still holds something and never touches `stop` itself.
 *
 * @param dispatch workspace op dispatcher
 * @param path the file that was removed
 * @param stop the working tree root
 * @param mounts the name plane's mount boundaries, null when none is wired
 */
export async function removeEmptyParents(
  dispatch: Dispatch,
  path: string,
  stop: string,
  mounts: MountView | null,
): Promise<void> {
  const root = stop.replace(/\/+$/, '') || '/'
  let current = parent(path)
  while (current !== root && current.startsWith(root)) {
    // A mount root is not a directory git made, and an empty one is still a
    // whole backend: removing it here would destroy the store behind it as a
    // side effect of tidying up. The walk stops rather than refusing, because
    // nothing the caller asked for has failed.
    if (mounts?.isRoot(current) === true) return
    if ((await readNames(dispatch, current)).length > 0) return
    try {
      await dispatch('rmdir', PathSpec.fromStrPath(current))
    } catch (err) {
      if (!isMissingPath(err)) throw err
      return
    }
    current = parent(current)
  }
}
