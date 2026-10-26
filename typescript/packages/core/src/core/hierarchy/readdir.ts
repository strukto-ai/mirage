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
import { ContentType, DirListing, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../errors/fs.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { ReaddirFn } from './probe.ts'
import { INVALID, ROOT, type DetectFn, type ScopeMatch } from './scope.ts'

export type Listed = FileStat[] | DirListing

export type Lister<A extends Accessor> = (accessor: A, match: ScopeMatch) => Promise<Listed | null>

export type EntryLister<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  entry: FileStat,
) => Promise<Listed>

export type Guard<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  virtual: string,
) => Promise<void>

export type PatternTest = (pattern: string) => boolean

export type ExtraFn = (match: ScopeMatch) => Record<string, string>

/**
 * What a paged listing's pages hold, and no page past the one that brings
 * `limit` rows; the pages are closed there. Mirrors Python's `held_pages`.
 */
export async function heldPages<T>(
  pages: AsyncIterable<T[]>,
  limit: number | undefined,
): Promise<T[]> {
  const held: T[] = []
  for await (const page of pages) {
    for (const item of page) held.push(item)
    if (limit !== undefined && held.length >= limit) break
  }
  return held
}

/**
 * A paged listing's rows, partial once they reach a walk's `limit`: its
 * lister stopped paging there, so a row past them may exist. Mirrors
 * Python's `cut_listing`.
 */
export function cutListing(rows: FileStat[], limit: number | undefined): Listed {
  if (limit !== undefined && rows.length >= limit)
    return new DirListing({ entries: rows, partial: true })
  return rows
}

/**
 * Build a hierarchy readdir: dispatch, guards, rows as stat answers.
 *
 * A lister fetches one directory kind and answers its children's stats;
 * classification, existence guards and the shape a kind shares happen here,
 * identically for every backend. Each listed row is finished from its own
 * kind: `extras` add the slots it was addressed by, and a leaf the lister
 * left untyped renders as its scope's filetype (JSON by default), so a listed
 * row is what `stat` answers. A dot-prefixed name is dropped from the
 * listing: the classifier refuses every dot-leading segment, so listing one
 * would advertise a path that stat, read and child readdir all report
 * absent. A lister may answer null instead of a listing: the directory's
 * container does not exist, reported as ENOENT on the virtual path. A lister
 * may answer a `DirListing` to seed descendant listings its fetch already
 * proved, or to mark a view or a window. A walk's `limit` reaches every
 * lister in `ScopeMatch.limit`.
 *
 * An entry lister is for a directory whose existence and contents are
 * already proven by its parent's listing: it is handed the row that listing
 * named (`entry`), so entering a directory a traversal just listed costs no
 * call beyond its own listing. The facts a child listing needs beyond the
 * API's own answers ride that row's `extra` (trello stashes each `card.json`
 * size on the card's row).
 *
 * A parent-entry lister is for a directory whose existence is decided by its
 * PARENT's row rather than its own, so the proof is the parent's row
 * (`parent`) and the fetch takes the rest from the match. A kind appears in
 * at most one of the three tables.
 *
 * `staticRoot` names fixed top-level directories, for backends whose root
 * never changes. `guards` are existence checks that run before the listing,
 * so a vanished container is ENOENT. `patternKinds` holds one entry per kind
 * whose listing is a bounded window, the test for whether a glob is one its
 * lister can move the window to (`hasGlobSpan` for a date-keyed listing): a
 * glob that passes reaches the lister in `ScopeMatch.pattern`, and the mount
 * serves no stored window for a glob. `leafError` is what listing a leaf
 * raises; fixed hierarchies historically answer ENOENT. `extras` are
 * per-kind `FileStat.extra` payloads derived from a listed row's own slots.
 * Mirrors `make_readdir` in `mirage/core/hierarchy/readdir.py`.
 */
export function makeReaddir<A extends Accessor>(
  detect: DetectFn,
  options: {
    listers: Readonly<Record<string, Lister<A>>>
    entryListers?: Readonly<Record<string, EntryLister<A>>>
    parentEntryListers?: Readonly<Record<string, EntryLister<A>>>
    staticRoot?: readonly string[]
    guards?: Readonly<Record<string, Guard<A>>>
    patternKinds?: Readonly<Record<string, PatternTest>>
    leafError?: 'enoent' | 'enotdir'
    extras?: Readonly<Record<string, ExtraFn>>
  },
): ReaddirFn<A> {
  const { listers, staticRoot, guards } = options
  const patternKinds = options.patternKinds ?? {}
  const entryListers = options.entryListers ?? {}
  const parentEntryListers = options.parentEntryListers ?? {}
  const leafError = options.leafError ?? 'enoent'
  const extras = options.extras ?? {}
  const overlap = [
    ...Object.keys(listers).filter(
      (kind) => entryListers[kind] !== undefined || parentEntryListers[kind] !== undefined,
    ),
    ...Object.keys(entryListers).filter((kind) => parentEntryListers[kind] !== undefined),
  ]
  if (overlap.length > 0) {
    throw new Error(`kinds in several lister tables: ${overlap.sort(compareCodePoints).join(', ')}`)
  }

  const finish = (row: FileStat, folder: string): FileStat => {
    const match = detect(`${folder}/${row.name}`)
    const extraFn = extras[match.kind]
    const scope = match.scope
    const typed = row.type === FileType.FILE && row.content === null && scope?.leaf === true
    if (extraFn === undefined && !typed) return row
    return row.with({
      ...(extraFn !== undefined ? { extra: { ...row.extra, ...extraFn(match) } } : {}),
      ...(typed ? { content: scope.filetype ?? ContentType.JSON } : {}),
    })
  }
  const shown = (rows: readonly FileStat[], folder: string): FileStat[] =>
    rows.filter((row) => !row.name.startsWith('.')).map((row) => finish(row, folder))

  return async function readdir(
    accessor: A,
    pathSpec: PathSpec,
    entry: FileStat | null = null,
    parent: FileStat | null = null,
    limit?: number,
  ): Promise<FileStat[] | DirListing> {
    const virtual = pathSpec.virtual
    const path = (pathSpec.pattern !== null ? pathSpec.dir : pathSpec).mountPath
    const folder = rstripSlash(path)
    const detected = detect(path)
    if (detected.kind === INVALID) throw enoent(virtual)
    const pushable = patternKinds[detected.kind]
    const globbed = pathSpec.pattern !== null && pushable?.(pathSpec.pattern) === true
    const match = {
      ...(globbed ? { ...detected, pattern: pathSpec.pattern } : detected),
      ...(limit === undefined ? {} : { limit }),
    }
    if (match.kind === ROOT && staticRoot !== undefined) {
      return shown(
        staticRoot.map((name) => new FileStat({ name, type: FileType.DIRECTORY })),
        folder,
      )
    }
    const lister = listers[match.kind]
    const entryLister = entryListers[match.kind]
    const parentLister = parentEntryListers[match.kind]
    if (lister === undefined && entryLister === undefined && parentLister === undefined) {
      if (match.scope !== null && match.scope.leaf && leafError === 'enotdir') {
        throw enotdir(virtual)
      }
      throw enoent(virtual)
    }
    const guard = guards?.[match.kind]
    if (guard !== undefined) await guard(accessor, match, virtual)
    let listed: Listed
    if (entryLister !== undefined) {
      if (entry === null) throw enoent(virtual)
      listed = await entryLister(accessor, match, entry)
    } else if (parentLister !== undefined) {
      if (parent === null) throw enoent(virtual)
      listed = await parentLister(accessor, match, parent)
    } else if (lister !== undefined) {
      const maybe = await lister(accessor, match)
      if (maybe === null) throw enoent(virtual)
      listed = maybe
    } else {
      throw enoent(virtual)
    }
    if (!(listed instanceof DirListing)) return shown(listed, folder)
    const seeds = new Map<string, FileStat[]>()
    for (const [rel, rows] of listed.seeds) {
      seeds.set(rel, shown(rows, `${folder}/${stripSlash(rel)}`))
    }
    return new DirListing({
      entries: shown(listed.entries, folder),
      seeds,
      partial: listed.partial,
      window: listed.window,
      version: listed.version,
    })
  }
}
