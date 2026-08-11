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

import { posixNormpath } from '../../../../utils/path.ts'
import { OutsideRepositoryError } from './errors.ts'
import type { RepoLocation } from './types.ts'

/**
 * The virtual path a path operand names.
 *
 * Resolved against the directory git was told to run in, not the session's,
 * because `-C` moves before anything else happens and a pathspec is read from
 * where git ended up. Resolving against the session cwd instead would make
 * `git -C /repo add letters.txt` reach for a file beside the shell rather than
 * inside the repository.
 *
 * @param start absolute virtual path git is running in
 * @param operand the operand as the user spelled it
 */
function absoluteOperand(start: string, operand: string): string {
  if (operand.startsWith('/')) return posixNormpath(operand)
  return posixNormpath(`${start}/${operand}`)
}

/**
 * A path operand as a repository-relative path.
 *
 * Empty string for the working tree root itself, which is what `git add .` from
 * the top resolves to and means "everything".
 *
 * @param location the discovered repository
 * @param start absolute virtual path git is running in
 * @param operand the operand as the user spelled it
 */
export function repoRelative(location: RepoLocation, start: string, operand: string): string {
  const absolute = absoluteOperand(start, operand)
  const root = location.worktree.replace(/\/+$/, '') || '/'
  if (absolute === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!absolute.startsWith(prefix)) throw new OutsideRepositoryError(operand, root)
  return absolute.slice(prefix.length)
}

/**
 * Whether a repository-relative path sits inside a directory. An empty
 * directory is the working tree root, which everything is under.
 *
 * @param path repository-relative path
 * @param directory repository-relative directory
 */
function under(path: string, directory: string): boolean {
  return directory === '' || path.startsWith(`${directory}/`)
}

/**
 * Every path a single operand selects: itself, or a whole subtree.
 *
 * @param paths the candidate paths, repository-relative
 * @param target the operand, repository-relative
 */
export function matched(paths: Iterable<string>, target: string): Set<string> {
  const all = [...paths]
  if (all.includes(target)) return new Set([target])
  return new Set(all.filter((path) => under(path, target)))
}
