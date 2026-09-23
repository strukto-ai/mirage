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
import type { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { resolveEntry, type ReaddirFn } from './probe.ts'
import { INVALID, ROOT, type DetectFn, type ScopeMatch } from './scope.ts'

/**
 * A listing that also proves descendant listings.
 *
 * For a backend whose one fetch answers more than one directory: a
 * dated-message day fetch yields the day's own children AND the contents of
 * its `files/` subdirectory, and a mail label listing yields the date
 * directories AND each date's messages AND each message's attachment
 * directory. Returning the extra listings as seeds lets the kit cache them,
 * so entering a seeded directory costs no second identical fetch. `seeds`
 * keys are paths relative to the listed directory (`files`,
 * `2026-01-05/Report__17`).
 *
 * `partial` says the entries are a filtered or truncated view rather than the
 * directory's contents, so they must not be cached as the directory: a
 * glob-scoped listing, or one the provider did not finish. The entries
 * themselves are real either way, so the kit caches those and lets the next
 * readdir re-list. `seeds` stay full listings of the children this fetch did
 * report, so they are cached as directories as usual.
 */
export interface DirListing {
  entries: [string, IndexEntry][]
  seeds: Readonly<Record<string, [string, IndexEntry][]>>
  partial?: boolean
}

export type Listed = [string, IndexEntry][] | DirListing

export type Lister<A extends Accessor> = (accessor: A, match: ScopeMatch) => Promise<Listed | null>

export type EntryLister<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  entry: IndexEntry,
) => Promise<Listed>

export type Guard<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  virtual: string,
) => Promise<void>

export type PatternTest = (pattern: string) => boolean

function dropHidden(listed: [string, IndexEntry][]): [string, IndexEntry][] {
  return listed.filter(([name]) => !name.startsWith('.'))
}

/**
 * Build a hierarchy readdir: dispatch, guards, index, name joins.
 *
 * A lister fetches one directory kind and returns `[vfsName, IndexEntry]`
 * pairs; everything else — classification, existence guards, the index probe
 * and write-back, and virtual name construction — happens here, identically
 * for every backend. A dot-prefixed name is dropped from the listing: the
 * classifier refuses every dot-leading segment, so listing one would
 * advertise a path that stat, read and child readdir all report absent.
 * A lister may answer null instead of a listing: the directory's container
 * does not exist, reported as ENOENT on the virtual path.
 *
 * An entry lister is for a directory whose existence and contents are
 * already proven by its parent's listing: the kit resolves the directory's
 * own index entry through `resolveEntry` (warming parent listings, each one
 * cached) and hands it over, so entering a directory a traversal just listed
 * costs no API call at all. A container lister that instead re-fetched its
 * ancestor chain per directory made a recursive walk quadratic in listing
 * payloads. The facts a child listing needs beyond the API's own answers
 * ride the parent listing's `IndexEntry.extra` (trello stashes each
 * `card.json` size on the card's directory entry).
 *
 * A lister may answer a `DirListing` to seed descendant listings its fetch
 * already proved; entering a seeded directory then reads the index instead of
 * refetching (the entry-lister branch re-checks the listing after resolving,
 * because the resolve itself may have run the seeding parent).
 *
 * A parent-entry lister (`parentEntryListers`) is for a directory whose
 * existence is decided by its PARENT's entry rather than its own: a
 * dated-message day dir is real for any well-formed date under a channel that
 * exists, including dates the channel's bounded listing window never minted,
 * so the proof is the channel entry and the fetch takes the date from the
 * match. A kind appears in at most one of the three tables.
 *
 * `listers` holds one lister per directory kind; include `root` for a
 * dynamic mount root. `entryListers` holds listers for kinds resolved
 * through their parent's listing; a kind appears in exactly one of the two
 * tables. `staticRoot` names fixed top-level entries, for backends whose
 * root never changes; it bypasses the index. `guards` are existence checks
 * that run before the index probe, so a vanished container is ENOENT even on
 * a warm cache. `patternKinds` holds one entry per kind whose listing is a
 * bounded window, the test for whether a glob is one its lister can move the
 * window to (`hasGlobSpan` for a date-keyed listing). A glob that passes
 * reaches the lister and the index is not read first, because a cached
 * listing is that same window and would answer the glob with it; any other
 * glob, and any other kind, keeps the cached listing and never sees a
 * pattern. `leafError` is what listing
 * a leaf raises; fixed hierarchies historically answer ENOENT.
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
  },
): ReaddirFn<A> {
  const { listers, staticRoot, guards } = options
  const patternKinds = options.patternKinds ?? {}
  const entryListers = options.entryListers ?? {}
  const parentEntryListers = options.parentEntryListers ?? {}
  const leafError = options.leafError ?? 'enoent'
  const overlap = [
    ...Object.keys(listers).filter(
      (kind) => entryListers[kind] !== undefined || parentEntryListers[kind] !== undefined,
    ),
    ...Object.keys(entryListers).filter((kind) => parentEntryListers[kind] !== undefined),
  ]
  if (overlap.length > 0) {
    throw new Error(`kinds in several lister tables: ${overlap.sort(compareCodePoints).join(', ')}`)
  }
  return async function readdir(
    accessor: A,
    pathSpec: PathSpec,
    index?: IndexCacheStore,
  ): Promise<string[]> {
    // Entry resolution and the parent-listing warm both read what readdir
    // just wrote, so a caller with no cache still needs one for the
    // duration of the call.
    const store = index ?? new RAMIndexCacheStore()
    const virtual = pathSpec.virtual
    const prefix = mountPrefixOf(pathSpec.virtual, pathSpec.vfsPath)
    const path = (pathSpec.pattern !== null ? pathSpec.dir : pathSpec).mountPath
    const key = stripSlash(path)
    const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
    const detected = detect(path)
    if (detected.kind === INVALID) throw enoent(pathSpec)
    const pushable = patternKinds[detected.kind]
    const globbed = pathSpec.pattern !== null && pushable?.(pathSpec.pattern) === true
    const match = globbed ? { ...detected, pattern: pathSpec.pattern } : detected
    if (match.kind === ROOT && staticRoot !== undefined) {
      return staticRoot.map((d) => `${prefix}/${d}`)
    }
    const lister = listers[match.kind]
    const entryLister = entryListers[match.kind]
    const parentLister = parentEntryListers[match.kind]
    if (lister === undefined && entryLister === undefined && parentLister === undefined) {
      if (match.scope !== null && match.scope.leaf && leafError === 'enotdir') {
        throw enotdir(pathSpec)
      }
      throw enoent(pathSpec)
    }
    const guard = guards?.[match.kind]
    if (guard !== undefined) await guard(accessor, match, virtual)
    if (!globbed) {
      const listing = await store.listDir(virtualKey)
      if (listing.entries !== undefined && listing.entries !== null) return listing.entries
    }
    let listed: Listed
    if (entryLister !== undefined || parentLister !== undefined) {
      const proofKey =
        parentLister !== undefined
          ? virtualKey.split('/').slice(0, -1).join('/') || '/'
          : virtualKey
      const own = await resolveEntry(
        readdir,
        accessor,
        new PathSpec({
          virtual: proofKey,
          directory: proofKey,
          resolved: false,
          vfsPath: mountKey(proofKey, prefix),
        }),
        store,
      )
      if (own === null) throw enoent(pathSpec)
      // The resolve may have warmed this very listing: a parent's lister
      // can seed a child listing from the same fetch (DirListing.seeds),
      // so ask the index again before fetching.
      if (!globbed) {
        const relisted = await store.listDir(virtualKey)
        if (relisted.entries !== undefined && relisted.entries !== null) return relisted.entries
      }
      const fetch = entryLister ?? parentLister
      if (fetch === undefined) throw enoent(pathSpec)
      listed = await fetch(accessor, match, own)
    } else if (lister !== undefined) {
      const maybe = await lister(accessor, match)
      if (maybe === null) throw enoent(pathSpec)
      listed = maybe
    } else {
      throw enoent(pathSpec)
    }
    let seeds: Readonly<Record<string, [string, IndexEntry][]>> = {}
    let partial = false
    if (!Array.isArray(listed)) {
      seeds = listed.seeds
      partial = listed.partial === true
      listed = listed.entries
    }
    const entries = dropHidden(listed)
    const stem = rstripSlash(virtualKey)
    if (partial) {
      for (const [name, entry] of entries) await store.put(`${stem}/${name}`, entry)
    } else {
      await store.setDir(virtualKey, entries)
    }
    for (const [rel, childEntries] of Object.entries(seeds)) {
      await store.setDir(`${stem}/${stripSlash(rel)}`, dropHidden(childEntries))
    }
    return entries.map(([name]) => `${stem}/${name}`)
  }
}
