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

import { FileStat, PathSpec } from '../../../types.ts'
import { isEnotdir, isMissError, isEnoent } from '../../../errors/fs.ts'
import { posixNormpath } from '../../../utils/path.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { NamespaceLinks } from '../../../view/types.ts'
import type { FsCondition } from '../../../errors/types.ts'
import { resolvePathStat } from '../../../commands/builtin/utils/paths.ts'

export async function statOrNull(dispatch: DispatchFn, path: PathSpec): Promise<FileStat | null> {
  // A missing destination is an expected mv case (plain rename), not an
  // error to surface. ENOTDIR counts as missing too: a path under a plain
  // file cannot exist. Anything else (a refusal, a loop, a transport error)
  // propagates, as Python's stat_or_none does: a permission error is not a
  // missing file, and a link whose target refuses its stat is not dangling.
  try {
    const [stat] = await dispatch('stat', path)
    return stat instanceof FileStat ? stat : null
  } catch (err) {
    if (isEnoent(err) || isEnotdir(err)) return null
    throw err
  }
}

// Stat one virtual path through the workspace, null when absent.
//
// Resolves through the op dispatcher rather than one backend, so a path
// under another mount answers correctly. This is what a traversal command
// asks about its own start point: a directory can be walked, a file is
// reported as itself, and null is GNU's missing-operand error.
export async function pathStat(
  dispatch: DispatchFn,
  virtual: string | PathSpec,
): Promise<FileStat | null> {
  return resolvePathStat(dispatch, PathSpec.fromStrPath(virtual, undefined, '/'))
}

// The condition a diagnostic names for a path pathStat found nothing at.
// pathStat answers null for both ways a lookup fails, since an existence
// probe treats them alike, while a diagnostic names the one the stat met:
// ENOTDIR for a path under a plain file, ELOOP for one a link loop stands
// in, ENOENT for the rest. Asked only after a miss, so its round trip is on
// the failure path. Mirrors miss_condition in probe.py.
export async function missCondition(
  dispatch: DispatchFn,
  virtual: string | PathSpec,
): Promise<FsCondition> {
  try {
    await dispatch('stat', PathSpec.fromStrPath(virtual, undefined, '/'))
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
export async function pathReaddir(
  dispatch: DispatchFn,
  virtual: string | PathSpec,
): Promise<string[]> {
  const spec = PathSpec.fromStrPath(virtual, undefined, '/')
  const [entries] = await dispatch('readdir', spec)
  return entries as string[]
}

// Whether a resolved virtual path names something that exists.
export async function pathExists(
  dispatch: DispatchFn,
  virtual: string | PathSpec,
): Promise<boolean> {
  try {
    return (await pathStat(dispatch, virtual)) !== null
  } catch {
    return false
  }
}

/**
 * Where a path really points, as the dispatcher can address it: the namespace's
 * walk, with a relative target's walk up from the link's own directory
 * (`../a.txt`) collapsed, which the dispatcher does not do for a path it is handed
 * whole. The link's directory is a real one, since the table keys every link
 * by its resolved parent, so the `..` it names is that directory's parent.
 * `links` is the session's link table (`Namespace.sessionLinks`). Throws
 * CycleError when the chain loops. Mirrors Python's resolve_link.
 */
export function resolveLink(links: NamespaceLinks, virtual: string): string {
  return posixNormpath(links.follow(virtual))
}

// The stat of what a link points at, or null when it dangles.
//
// Under -L the reported entity is the target, so its type drives -type
// and its size and mtime drive -size and -mtime. The stat goes through
// dispatch rather than one backend because a link may point into
// another mount. `links` is the session's link table
// (`Namespace.sessionLinks`). Mirrors Python's link_target_stat.
export async function linkTargetStat(
  links: NamespaceLinks,
  dispatch: DispatchFn,
  virtual: string,
): Promise<FileStat | null> {
  let target: string
  try {
    target = resolveLink(links, virtual)
  } catch {
    // A loop (ELOOP) is one of the two ways a link legitimately has no
    // target; statOrNull maps the other (missing). Every other backend
    // failure propagates, because a permission or connection error is
    // not a dangling link and reporting it as one would print the link
    // as -type l and exit 0.
    return null
  }
  return statOrNull(dispatch, PathSpec.fromStrPath(target, ''))
}
