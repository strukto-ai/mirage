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

import type { PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'

/** Map a mount path to the Dropbox API path under the configured root. */
export function dropboxPathOf(accessor: DropboxAccessor, path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
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
