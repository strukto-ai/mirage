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

import { lookup, type DropboxEntry } from './api.ts'
import { soleCommandStarted } from '../../cache/index/scope.ts'
import { enoent } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { rawPathOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'

/** Map a mount path to the Dropbox API path under the configured root. */
export function dropboxPathOf(accessor: DropboxAccessor, path: PathSpec): string {
  const key = stripSlash(rawPathOf(path))
  return key === '' ? accessor.rootPath : `${accessor.rootPath}/${key}`
}

/**
 * Whether Dropbox answered for `path` with a name in another case.
 *
 * Dropbox matches a path case-insensitively, a listing does not: a file stored
 * as `N` is not `n`. An answer without a name proves nothing, and calling it
 * absent would let a write go out over a file that is there. Mirrors Python's
 * `spelled_otherwise`.
 */
export function spelledOtherwise(
  path: PathSpec,
  entry: { readonly name?: unknown } | null,
): boolean {
  const key = stripSlash(path.vfsPath)
  const named = entry?.name
  return typeof named === 'string' && named !== key.slice(key.lastIndexOf('/') + 1)
}

/**
 * Validate existing components below the configured root, never accepting case
 * aliases. A folder the running command has found spelled exactly already is
 * not asked about again (`DropboxAccessor.proven`), so a walk's reads share the
 * folders above them instead of each asking for every one. Only such a folder
 * is remembered, and only for the command, which its start stamp names: a
 * streamed read runs as its output is pulled, after the command's own scope
 * has closed, and still carries the stamp. The final name is always asked,
 * since its entry is the answer. Mirrors Python's `check_path`.
 */
export async function checkPath(
  accessor: DropboxAccessor,
  path: PathSpec,
): Promise<DropboxEntry | null> {
  const key = stripSlash(rawPathOf(path))
  const parts = key === '' ? [] : key.split('/')
  const started = soleCommandStarted()
  let proven = new Set<string>()
  if (started !== null) {
    if (accessor.proven?.started !== started) accessor.proven = { started, folders: proven }
    proven = accessor.proven.folders
  }
  let at = accessor.rootPath
  let entry: DropboxEntry | null = null
  for (const [i, part] of parts.entries()) {
    at = `${at}/${part}`
    const folder = i < parts.length - 1
    if (folder && proven.has(at)) continue
    entry = await lookup(accessor.tokenManager, at)
    if (entry == null) return null
    if (typeof entry.name === 'string' && entry.name !== part) throw enoent(path.virtual)
    if (folder) proven.add(at)
  }
  return entry
}
