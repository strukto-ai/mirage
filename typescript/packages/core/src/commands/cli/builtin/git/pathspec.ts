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

import { joinSpec, posixNormpath } from '../../../../utils/path.ts'
import { byteView } from '../../../../shell/bytes.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import { EmptyPathspecError, OutsideRepositoryError, UnsupportedPathspecError } from './errors.ts'
import { pathVisible } from '../../../../utils/hidden.ts'
import type { RepoLocation } from './types.ts'
import { rstripSlash } from '../../../../utils/slash.ts'

const MAGIC = ':'
const SLASH = '/'

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
 * the top resolves to and means "everything". Git uses the work tree as the
 * base when invoked from outside it, as with --git-dir and --work-tree.
 *
 * @param location the discovered repository
 * @param start absolute virtual path git is running in
 * @param operand the operand as the user spelled it
 */
export function repoRelative(location: RepoLocation, start: string, operand: string): string {
  const root = rstripSlash(location.worktree.virtual) || '/'
  const prefix = root.endsWith('/') ? root : `${root}/`
  const base = start === root || start.startsWith(prefix) ? start : root
  const absolute = absoluteOperand(base, operand)
  if (absolute === root) return ''
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
export function under(path: string, directory: string): boolean {
  return directory === '' || path.startsWith(`${directory}/`)
}

/**
 * Every path a single operand selects: itself and its whole subtree.
 *
 * Both, not one or the other. A pathspec matches a path that equals it
 * and a path it is a leading directory of, and the two are not exclusive
 * as soon as the candidates come from more than one tree: restoring
 * `slot` where the index holds the file `slot` and the source holds
 * `slot/child` has to select both, or the file is deleted and the
 * directory never written. git 2.50.1 replaces one with the other in
 * either direction.
 *
 * @param paths the candidate paths, repository-relative
 * @param target the operand, repository-relative
 */
export function matched(paths: Iterable<string>, target: string): Set<string> {
  return new Set([...paths].filter((path) => path === target || under(path, target)))
}

/**
 * Pathspec operands as the repository-relative patterns they name.
 *
 * A trailing slash survives, because `docs/` names only what lies under a
 * directory where `docs` also names a file of that name. An empty operand is
 * git's own refusal, and magic (`:(top)`, `:!`) is refused as unsupported
 * rather than matched as a path.
 *
 * @param location the discovered repository
 * @param start absolute virtual path git is running in
 * @param operands the pathspecs as typed
 */
export function pathspecPatterns(
  location: RepoLocation,
  start: string,
  operands: readonly string[],
): string[] {
  return operands.map((operand) => {
    if (operand === '') throw new EmptyPathspecError()
    if (operand.startsWith(MAGIC)) throw new UnsupportedPathspecError(operand)
    const pattern = repoRelative(location, start, operand)
    return pattern !== '' && operand.endsWith(SLASH) ? pattern + SLASH : pattern
  })
}

/**
 * Whether a repository-relative path is one a pathspec names.
 *
 * git's default pathspec: a path it spells, a directory the path lies under
 * (`docs` and `docs/` both name `docs/a.md`, only `docs` names a file `docs`),
 * or a wildcard pattern matching the whole path. A wildcard crosses `/`, so
 * `*.c` finds `sub/x.c`, and matches bytes, so `??.txt` is what names `é.txt`
 * (pinned against git 2.54). A tree a diff does not descend into is also named
 * by a pathspec inside it, which is how `diff-tree A -- dir/x` prints `dir`.
 *
 * @param path repository-relative path, surrogate-escaped
 * @param patterns patterns from `pathspecPatterns`
 * @param directory whether the path is a tree left undescended
 */
export function pathspecSelects(
  path: string,
  patterns: readonly string[],
  directory = false,
): boolean {
  return patterns.some((pattern) => selects(path, pattern, directory))
}

/** Whether one pattern names a path; see `pathspecSelects`. */
function selects(path: string, pattern: string, directory: boolean): boolean {
  const stem = pattern.endsWith(SLASH) ? pattern.slice(0, -1) : pattern
  if (under(path, stem) || path === pattern) return true
  if (directory && (path === stem || under(stem, path))) return true
  return fnmatch(byteView(path), byteView(pattern))
}

/** Whether a repository entry belongs to the session's visible tree. */
export function visiblePath(location: RepoLocation, relative: string): boolean {
  const ns = location.ns
  if (ns?.visibility === undefined) return true
  const path = joinSpec(location.worktree, relative)
  if (!pathVisible(ns.visibility, path.virtual)) return false
  const parent = ns.links?.resolve(path.directory) ?? path.directory
  const followed = joinSpec(parent, path.virtual.slice(path.virtual.lastIndexOf('/') + 1))
  return pathVisible(ns.visibility, followed.virtual)
}

/** A session view of Git entries; the persistent mapping stays intact. */
export function visibleEntries<T>(
  location: RepoLocation,
  entries: ReadonlyMap<string, T>,
): Map<string, T> {
  return new Map([...entries].filter(([path]) => visiblePath(location, path)))
}
