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
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { FileType, type PathSpec, type StatFn } from '../../../types.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { eloop, enoent, enotdir, isMissingPath } from '../../../errors/fs.ts'

// The destination verdicts GNU meets at the destination's own stat, before
// any create or rename: a plain file in its chain, or a link loop in it. cp
// and mv both word them `cannot stat 'DST'` (coreutils 9.7). Mirrors
// Python's STAT_REFUSALS.
export const STAT_REFUSALS: ReadonlySet<string> = new Set([
  posixPhrase('ENOTDIR'),
  posixPhrase('ELOOP'),
])
import { rstripSlash } from '../../../utils/slash.ts'

export type BackendKeyFn = (path: PathSpec) => string

export function backendKeyDefault(path: PathSpec): string {
  return rstripSlash(path.mountPath)
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
export function copyTargets(
  sources: PathSpec[],
  dst: PathSpec,
  dstIsDir: boolean,
  dstExists = true,
  dstErr: string | null = null,
): [PathSpec, PathSpec][] {
  if (sources.length > 1 && !dstIsDir) {
    if (dstErr === posixPhrase('ELOOP')) throw eloop(`target '${dst.rawPath}'`)
    if (!dstExists && dstErr !== posixPhrase('ENOTDIR')) throw enoent(`target '${dst.rawPath}'`)
    throw enotdir(`target '${dst.rawPath}'`)
  }
  if (!dstIsDir) {
    const first = sources[0]
    return first === undefined ? [] : [[first, dst]]
  }
  return sources.map((src): [PathSpec, PathSpec] => [src, childPath(dst, landingName(src))])
}

/**
 * The name a source lands under inside a directory destination. GNU names it
 * after the operand as typed, so a link the router followed still lands under
 * its own name (`cp al dir` makes `dir/al`, not `dir/a.txt`). `''`, `.` and
 * `..` name no entry of their own, so they keep the name of what they resolve
 * to. Mirrors Python's landing_name.
 */
export function landingName(src: PathSpec): string {
  const typed = rstripSlash(src.rawPath).split('/').pop() ?? ''
  if (typed !== '' && typed !== '.' && typed !== '..') return typed
  return rstripSlash(src.mountPath).split('/').pop() ?? ''
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

export async function isDirectory(
  stat: StatFn,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<boolean> {
  try {
    const info = await stat(path, index)
    return info.type === FileType.DIRECTORY
  } catch (err) {
    if (isMissingPath(err)) return false
    throw err
  }
}
