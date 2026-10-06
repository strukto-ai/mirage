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

import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { isEnotdir, isMissError } from '../../../errors/fs.ts'
import { gnuBasename, posixNormpath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { StatOverlay } from '../../../ops/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { Namespace } from './namespace.ts'
import type { FsCondition } from '../../../errors/types.ts'

export async function statOrNull(dispatch: DispatchFn, path: PathSpec): Promise<FileStat | null> {
  // A missing destination is an expected mv case (plain rename), not an
  // error to surface.
  try {
    const [stat] = await dispatch('stat', path)
    return stat instanceof FileStat ? stat : null
  } catch {
    return null
  }
}

// What a path is, asked on both channels a backend can answer on.
//
// A point lookup alone cannot decide. On a prefix store a directory is not
// an object, it is the set of keys under it, so stat misses what readdir
// would list. Absence therefore takes *both* channels coming back empty,
// which is the only evidence that nothing is there.
//
// The listing has to be non-empty to count: those stores answer a missing
// path with [] rather than raising, and cannot hold an empty directory
// anyway (one with no keys under it does not exist). Measured across every
// integ target: an implicit directory answers here, a missing path does not.
// That holds only while a backend's readdir refuses a path it cannot prove:
// postgres answered tables/views under any first segment, and every absent
// schema read as a directory here.
//
// A link loop in the path is absence too: the walk reaches nothing there,
// which is the question this answers, and a diagnostic that has to name
// the errno asks missCondition.
export async function resolvePathStat(
  dispatch: DispatchFn,
  path: PathSpec,
): Promise<FileStat | null> {
  let stat: FileStat | null = null
  try {
    const [s] = await dispatch('stat', path)
    stat = s as FileStat | null
  } catch (exc) {
    if (!isMissError(exc) && !isEloop(exc)) throw exc
  }
  if (stat !== null) return stat
  let entries: unknown
  try {
    const [raw] = await dispatch('readdir', path)
    entries = raw
  } catch (exc) {
    if (!isMissError(exc) && !isEloop(exc)) throw exc
    return null
  }
  if (!Array.isArray(entries) || entries.length === 0) return null
  return new FileStat({
    name: gnuBasename(rstripSlash(path.virtual)),
    type: FileType.DIRECTORY,
  })
}

// Stat one virtual path through the workspace, null when absent.
//
// Resolves through the op dispatcher rather than one backend, so a path
// under another mount answers correctly. This is what a traversal command
// asks about its own start point: a directory can be walked, a file is
// reported as itself, and null is GNU's missing-operand error. The
// overlay is applied on the way out for the reason linkTargetStat states:
// Python's dispatcher applies it itself, this one does not.
export async function pathStat(
  dispatch: DispatchFn,
  virtual: string,
  overlay: StatOverlay | null = null,
): Promise<FileStat | null> {
  const spec = PathSpec.fromStrPath(virtual, '')
  const stat = await resolvePathStat(dispatch, spec)
  if (stat === null) return null
  return overlay !== null ? overlay(virtual, stat) : stat
}

// The condition a diagnostic names for a path pathStat found nothing at.
// pathStat answers null for both ways a lookup fails, since an existence
// probe treats them alike, while a diagnostic names the one the stat met:
// ENOTDIR for a path under a plain file, ELOOP for one a link loop stands
// in, ENOENT for the rest. Asked only after a miss, so its round trip is on
// the failure path. Mirrors miss_condition in probe.py.
export async function missCondition(dispatch: DispatchFn, virtual: string): Promise<FsCondition> {
  try {
    await dispatch('stat', PathSpec.fromStrPath(virtual))
  } catch (err) {
    if (isEnotdir(err)) return 'ENOTDIR'
    if (isMissError(err)) return 'ENOENT'
    if (isEloop(err)) return 'ELOOP'
    throw err
  }
  return 'ENOENT'
}

function isEloop(err: unknown): boolean {
  return (err as { code?: string }).code === 'ELOOP'
}

// List one virtual path through the workspace, as virtual paths.
//
// Resolves through the op dispatcher rather than one backend, so a
// directory served by another mount answers. This is what a walker reads
// once it crosses a mount boundary: the subtree under a nested mount
// lives in a VFS the walker's own accessor cannot open.
export async function pathReaddir(dispatch: DispatchFn, virtual: string): Promise<string[]> {
  const spec = PathSpec.fromStrPath(virtual, '')
  const [entries] = await dispatch('readdir', spec)
  return entries as string[]
}

// Whether a resolved virtual path names something that exists.
export async function pathExists(dispatch: DispatchFn, virtual: string): Promise<boolean> {
  try {
    return (await pathStat(dispatch, virtual)) !== null
  } catch {
    return false
  }
}

// The stat of what a link points at, or null when it dangles.
//
// Under -L the reported entity is the target, so its type drives -type
// and its size and mtime drive -size and -mtime. The stat goes through
// dispatch rather than one backend because a link may point into
// another mount, and through the overlay because the target's mtime may
// be namespace state (touch results, observed writes). Python gets the
// overlay from the ops dispatcher itself; here it is applied on the way
// out, against the resolved path rather than the link's.
/**
 * Where a path really points, as the door can address it: the namespace's
 * walk, with a relative target's walk up from the link's own directory
 * (`../a.txt`) collapsed, which the door does not do for a path it is handed
 * whole. The link's directory is a real one, since the table keys every link
 * by its resolved parent, so the `..` it names is that directory's parent.
 * Throws CycleError when the chain loops. Mirrors Python's resolve_link.
 */
export function resolveLink(namespace: Namespace, virtual: string): string {
  return posixNormpath(namespace.follow(virtual))
}

export async function linkTargetStat(
  namespace: Namespace,
  dispatch: DispatchFn,
  virtual: string,
  overlay: StatOverlay | null,
): Promise<FileStat | null> {
  let target: string
  try {
    target = resolveLink(namespace, virtual)
  } catch {
    // A loop (ELOOP) is one of the two ways a link legitimately has no
    // target; statOrNull maps the other (missing). Every other backend
    // failure propagates, because a permission or connection error is
    // not a dangling link and reporting it as one would print the link
    // as -type l and exit 0.
    return null
  }
  const stat = await statOrNull(dispatch, PathSpec.fromStrPath(target, ''))
  if (stat === null || overlay === null) return stat
  return overlay(target, stat)
}
