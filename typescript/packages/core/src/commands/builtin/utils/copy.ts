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

import { descendantPath } from './paths.ts'
import { FileType, type PathSpec, type StatFn } from '../../../types.ts'
import { eacces, eloop, enoent, enotdir, isMissingPath } from '../../../errors/fs.ts'

// The destination verdicts GNU meets at the destination's own stat, before
// any create or rename: a plain file in its chain, a link loop in it, or a
// refused stat, a store's or a policy's. cp and mv both word them `cannot stat 'DST'`
// (coreutils 9.7). Mirrors Python's STAT_REFUSALS.
export const STAT_REFUSALS: ReadonlySet<FsCondition> = new Set<FsCondition>([
  'ENOTDIR',
  'ELOOP',
  'EACCES',
])
import { rstripSlash } from '../../../utils/slash.ts'
import { respelled } from '../../../utils/key_prefix.ts'
import { parent } from '../../../utils/path.ts'
import type { FsCondition } from '../../../errors/types.ts'

export type BackendKeyFn = (path: PathSpec) => string

export function backendKeyDefault(path: PathSpec): string {
  return rstripSlash(path.virtual)
}

function childPath(parent: PathSpec, name: string): PathSpec {
  return descendantPath(parent, `${rstripSlash(parent.virtual)}/${name}`)
}

// Multiple sources require the directory form, and GNU distinguishes why it
// is unusable: an absent target is "No such file or directory"; an existing
// non-directory is "Not a directory", and so is a target that can never
// exist because a plain file stands in its chain or behind its slash
// (`cp a b reg/x`, `cp a b reg/`), which the destination probe reports as
// its strerror (identical wording in cp and mv).
//
// A source typed as `..` lands as `dotdot`: `..`, the destination's parent,
// for mv; `.` for cp, which never copies into `dir/..` (coreutils 9.7).
export function copyTargets(
  sources: PathSpec[],
  dst: PathSpec,
  dstIsDir: boolean,
  dstExists = true,
  dstErr: FsCondition | null = null,
  dotdot = '..',
): [PathSpec, PathSpec][] {
  if (sources.length > 1 && !dstIsDir) {
    if (dstErr === 'ELOOP') throw eloop(`target '${dst.rawPath}'`)
    if (dstErr === 'EACCES') throw eacces(`target '${dst.rawPath}'`)
    if (!dstExists && dstErr !== 'ENOTDIR') throw enoent(`target '${dst.rawPath}'`)
    throw enotdir(`target '${dst.rawPath}'`)
  }
  if (!dstIsDir) {
    const first = sources[0]
    return first === undefined ? [] : [[first, dst]]
  }
  return sources.map((src): [PathSpec, PathSpec] => [src, landingPath(dst, src, dotdot)])
}

// The operand's last component as typed, trailing slashes dropped.
export function typedName(src: PathSpec): string {
  return rstripSlash(src.rawPath).split('/').pop() ?? ''
}

/**
 * Where a source lands inside a directory destination. GNU appends the
 * operand's last component as typed, so a link the router followed still
 * lands under its own name (`cp al dir` makes `dir/al`, not `dir/a.txt`), and
 * `s/.` lands at `dir/.`, the directory itself: `cp -r s/. dir` merges s's
 * contents into dir. An operand with no name of its own (the root) keeps the
 * name of what it resolves to. `dotdot` is what a `..` operand lands as (see
 * copyTargets). Mirrors Python's landing_path.
 */
export function landingPath(dst: PathSpec, src: PathSpec, dotdot = '..'): PathSpec {
  let typed = typedName(src)
  if (typed === '..') typed = dotdot
  if (typed === '') typed = rstripSlash(src.virtual).split('/').pop() ?? ''
  if (typed !== '.' && typed !== '..') return childPath(dst, typed)
  const base = dst.rawPath
  const shown = base === '' || base.endsWith('/') ? `${base}${typed}` : `${base}/${typed}`
  if (typed === '.') return respelled(dst, shown)
  return respelled(descendantPath(dst, parent(rstripSlash(dst.virtual))), shown)
}

export async function pathExists(stat: StatFn, path: PathSpec): Promise<boolean> {
  try {
    await stat(path)
  } catch (err) {
    if (isMissingPath(err)) return false
    throw err
  }
  return true
}

export async function isDirectory(stat: StatFn, path: PathSpec): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.type === FileType.DIRECTORY
  } catch (err) {
    if (isMissingPath(err)) return false
    throw err
  }
}
