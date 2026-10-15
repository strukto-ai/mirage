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

import type { Accessor } from '../../accessor/base.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { ExtraFn, Guard } from './readdir.ts'
import { ROOT, type DetectFn, type ScopeMatch } from './scope.ts'

export type StatHook<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
  parent: FileStat | null,
) => Promise<FileStat>

export type RowFn = (
  name: string,
  ident: string,
  options?: {
    size?: number | null
    modified?: string | null
    extra?: Readonly<Record<string, unknown>>
  },
) => FileStat

// The node kinds, so `entryStat` can tell a FileType from a ContentType:
// both are string unions and the two vocabularies do not overlap.
const KINDS: ReadonlySet<string> = new Set(Object.values(FileType))

/**
 * The row most id-addressed nodes share, keyed by an id field: the listed
 * name, size and modified time, and the node's id under `idField` in
 * `extra`, with whatever else the lister keeps for a child listing to read
 * back. A kind whose shape differs builds its own row instead.
 *
 * `kind` is the node's kind: a FileType for a non-regular node (a
 * directory), a ContentType for a regular file, whose node kind is then
 * FILE, or undefined for a regular file typed by its name (a mail
 * attachment). Mirrors `entry_stat` in `mirage/core/hierarchy/stat.py`.
 */
export function entryStat(idField: string, kind?: FileType | ContentType): RowFn {
  const node = kind !== undefined && KINDS.has(kind) ? (kind as FileType) : null
  return function build(name, ident, options = {}): FileStat {
    const extra = { ...(options.extra ?? {}), [idField]: ident }
    const modified = options.modified ?? null
    return new FileStat({
      name,
      ...(node !== null
        ? { type: node }
        : {
            type: FileType.FILE,
            content: (kind as ContentType | undefined) ?? contentTypeForPath(name),
          }),
      size: options.size ?? null,
      modified: modified !== '' ? modified : null,
      extra,
    })
  }
}

/**
 * Build a hierarchy stat: the listed row, or a shape the kind holds.
 *
 * A path its parent's listing names answers with that row, which the mount
 * hands in (`entry`). A kind whose existence the API answers directly has a
 * guard instead, and one that exists by construction (the top-level
 * directories) needs no proof; both answer the shape their scope gives them.
 * An override replaces the whole answer for a kind with a bespoke stat,
 * handed what is at the path and at its parent. Mirrors `make_stat` in
 * `mirage/core/hierarchy/stat.py`.
 */
export function makeStat<A extends Accessor>(
  detect: DetectFn,
  options: {
    guards?: Readonly<Record<string, Guard<A>>>
    extras?: Readonly<Record<string, ExtraFn>>
    overrides?: Readonly<Record<string, StatHook<A>>>
  } = {},
): (
  accessor: A,
  path: PathSpec,
  entry?: FileStat | null,
  parent?: FileStat | null,
) => Promise<FileStat> {
  const { guards, extras, overrides } = options
  return async function stat(
    accessor: A,
    path: PathSpec,
    entry: FileStat | null = null,
    parent: FileStat | null = null,
  ): Promise<FileStat> {
    const virtual = path.virtual
    const match = detect(path)
    if (match.kind === ROOT) return new FileStat({ name: '/', type: FileType.DIRECTORY })
    const scope = match.scope
    if (scope === null) throw enoent(virtual)
    const override = overrides?.[match.kind]
    if (override !== undefined) return override(accessor, match, path, entry, parent)
    if (entry !== null) return entry
    const guard = guards?.[match.kind]
    if (guard !== undefined) await guard(accessor, match, virtual)
    else if (scope.probed) throw enoent(virtual)
    const parts = stripSlash(path.vfsPath).split('/')
    const name = parts[parts.length - 1] ?? ''
    const extra = extras?.[match.kind]?.(match) ?? {}
    if (!scope.leaf) return new FileStat({ name, type: FileType.DIRECTORY, extra })
    return new FileStat({
      name,
      type: FileType.FILE,
      content: scope.filetype ?? ContentType.JSON,
      extra,
    })
  }
}
