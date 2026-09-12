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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import {
  Delta,
  FileChangeKind,
  FileEvent,
  FileMetadata,
  type PathSpec,
  type WalkEntry,
} from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { DIR_FINGERPRINT } from '../../watch/constants.ts'
import { ListingDeltaHook, specFor } from '../../watch/delta.ts'
import { statFingerprint } from '../../watch/fingerprint.ts'
import { DropboxApiError } from './client.ts'
import { continueFolder, listFolder, listFolderState, type DropboxEntry } from './api.ts'
import { dropboxPathOf } from './paths.ts'

const NATIVE = 1

/**
 * One recursive `list_folder` feeding the generic listing differ.
 *
 * Reads the account directly, never through mirage's caches, as the DeltaHook
 * contract requires.
 *
 * Fingerprints on `content_hash`, Dropbox's own content digest, so an upload of
 * identical bytes is correctly reported as no change; `rev` is the fallback,
 * and it moves on any write.
 *
 * Dropbox also offers a cursor: the same endpoint returns one, and
 * `list_folder/continue` replays only what changed since. That is a faster
 * pull, not a more correct one, and it cannot replace this walk, because the
 * server may invalidate a cursor at any time and the only answer to that is a
 * full listing. `DropboxDeltaHook` uses the cursor behind `pull` and this walk
 * as its reset path.
 */
export class DropboxWalk {
  private readonly accessor: DropboxAccessor

  constructor(accessor: DropboxAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const accessor = this.accessor
    const apiRoot = dropboxPathOf(accessor, root)
    let found
    try {
      found = await listFolder(accessor.tokenManager, apiRoot, { recursive: true })
    } catch (error) {
      // list_folder 409s on a missing path and on a file operand;
      // either way there is nothing under this root to report.
      if (error instanceof DropboxApiError && error.status === 409) return
      throw error
    }
    for (const entry of found) {
      const framed = frame(accessor, root, entry)
      if (framed === null || entry['.tag'] === 'deleted') continue
      yield framed.walk
    }
  }
}

function isReset(error: DropboxApiError): boolean {
  return error.status === 409 && error.summary.startsWith('reset')
}

function frame(
  accessor: DropboxAccessor,
  root: PathSpec,
  entry: DropboxEntry,
): { virtual: string; walk: WalkEntry } | null {
  // Dropbox paths are case-insensitive: `path_display` carries the
  // server's casing while `rootPath` carries the user's, so a configured
  // `/team` whose displayed path is `/Team` matched nothing and every
  // event landed outside the watch scope. The comparison folds case; the
  // slice keeps the server's casing for everything below the root, and is
  // safe because `path_lower` is `path_display` lowercased, same length.
  const prefix = mountPrefixOf(root.virtual, root.resourcePath)
  const display = entry.path_display ?? entry.path_lower
  if (display === undefined || display === '') return null
  const base = accessor.rootPath
  const folded = base.toLowerCase()
  const trimmed =
    base !== '' && display.toLowerCase().startsWith(folded) ? display.slice(base.length) : display
  const relative = stripSlash(trimmed)
  if (relative === '') return null
  const virtual = prefix !== '' ? `${prefix}/${relative}` : `/${relative}`
  if (entry['.tag'] === 'folder') {
    return { virtual, walk: { virtual, isDir: true, fingerprint: null } }
  }
  if (entry['.tag'] === 'deleted') {
    return { virtual, walk: { virtual, isDir: false, fingerprint: null } }
  }
  const modified = entry.server_modified ?? entry.client_modified ?? null
  const size = typeof entry.size === 'number' ? entry.size : null
  const version = entry.content_hash ?? entry.rev ?? null
  return {
    virtual,
    walk: {
      virtual,
      isDir: false,
      fingerprint: statFingerprint(version, modified, size),
      size,
      modified,
    },
  }
}

function encode(cursor: string, snapshot: Record<string, string>): string {
  const ordered: Record<string, string> = {}
  for (const key of Object.keys(snapshot).sort(compareCodePoints)) {
    const value = snapshot[key]
    if (value !== undefined) ordered[key] = value
  }
  return JSON.stringify({ _dbx: NATIVE, c: cursor, s: ordered })
}

function decode(checkpoint: string | null): {
  cursor: string | null
  snapshot: Record<string, string> | null
  native: boolean
} {
  if (checkpoint === null) return { cursor: null, snapshot: null, native: false }
  const data = JSON.parse(checkpoint) as Record<string, unknown>
  if (
    data._dbx === NATIVE &&
    typeof data.c === 'string' &&
    typeof data.s === 'object' &&
    data.s !== null
  ) {
    return { cursor: data.c, snapshot: data.s as Record<string, string>, native: true }
  }
  return { cursor: null, snapshot: data as Record<string, string>, native: false }
}

function eventOf(
  root: PathSpec,
  virtual: string,
  kind: FileChangeKind,
  entry: WalkEntry | undefined,
  observed: Date,
): FileEvent {
  const metadata =
    entry !== undefined && !entry.isDir && kind !== FileChangeKind.DELETE
      ? new FileMetadata({
          fingerprint: entry.fingerprint,
          size: entry.size ?? null,
          modified: entry.modified ?? null,
        })
      : null
  return new FileEvent({ kind, path: specFor(root, virtual), timestamp: observed, metadata })
}

function diffSnapshots(
  root: PathSpec,
  previous: Record<string, string>,
  current: Record<string, string>,
  entries: Map<string, WalkEntry>,
  observed: Date,
): FileEvent[] {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(previous)])].sort(
    compareCodePoints,
  )
  const changes: FileEvent[] = []
  for (const virtual of keys) {
    const old = previous[virtual]
    const next = current[virtual]
    if (old === next) continue
    const kind =
      old === undefined && next !== undefined
        ? FileChangeKind.CREATE
        : next === undefined
          ? FileChangeKind.DELETE
          : FileChangeKind.UPDATE
    changes.push(eventOf(root, virtual, kind, entries.get(virtual), observed))
  }
  return changes
}

function dropPrefix(snapshot: Record<string, string>, virtual: string): Record<string, string> {
  const prefix = `${virtual.replace(/\/$/, '')}/`
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== virtual && !key.startsWith(prefix)) next[key] = value
  }
  return next
}

/**
 * Native Dropbox cursor pull, with the listing walk as reset.
 */
export class DropboxDeltaHook implements DeltaHook {
  private readonly accessor: DropboxAccessor
  private readonly listing: ListingDeltaHook

  constructor(accessor: DropboxAccessor) {
    this.accessor = accessor
    const walk = new DropboxWalk(accessor)
    this.listing = new ListingDeltaHook(walk.walk.bind(walk))
  }

  private async snapshot(root: PathSpec): Promise<{
    snapshot: Record<string, string>
    entries: Map<string, WalkEntry>
    cursor: string
  }> {
    const accessor = this.accessor
    const apiRoot = dropboxPathOf(accessor, root)
    let found: DropboxEntry[]
    let cursor: string
    try {
      const state = await listFolderState(accessor.tokenManager, apiRoot, { recursive: true })
      found = state.entries
      cursor = state.cursor
    } catch (error) {
      if (error instanceof DropboxApiError && error.status === 409) {
        return { snapshot: {}, entries: new Map(), cursor: '' }
      }
      throw error
    }
    const snapshot: Record<string, string> = {}
    const entries = new Map<string, WalkEntry>()
    for (const raw of found) {
      const framed = frame(accessor, root, raw)
      if (framed === null || raw['.tag'] === 'deleted') continue
      entries.set(framed.virtual, framed.walk)
      snapshot[framed.virtual] = framed.walk.isDir
        ? DIR_FINGERPRINT
        : (framed.walk.fingerprint ?? '')
    }
    return { snapshot, entries, cursor }
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const decoded = decode(checkpoint)
    const observed = new Date()
    if (!decoded.native) {
      const next = await this.snapshot(root)
      if (next.cursor === '') return this.listing.pull(root, checkpoint)
      const changes =
        decoded.snapshot === null
          ? []
          : diffSnapshots(root, decoded.snapshot, next.snapshot, next.entries, observed)
      return new Delta({ changes, checkpoint: encode(next.cursor, next.snapshot) })
    }
    try {
      const state = await continueFolder(this.accessor.tokenManager, decoded.cursor ?? '')
      let snapshot = { ...(decoded.snapshot ?? {}) }
      const entries = new Map<string, WalkEntry>()
      for (const raw of state.entries) {
        const framed = frame(this.accessor, root, raw)
        if (framed === null) continue
        entries.set(framed.virtual, framed.walk)
        if (raw['.tag'] === 'deleted') {
          snapshot = dropPrefix(snapshot, framed.virtual)
          continue
        }
        snapshot[framed.virtual] = framed.walk.isDir
          ? DIR_FINGERPRINT
          : (framed.walk.fingerprint ?? '')
      }
      return new Delta({
        changes: diffSnapshots(root, decoded.snapshot ?? {}, snapshot, entries, observed),
        checkpoint: encode(state.cursor, snapshot),
      })
    } catch (error) {
      if (error instanceof DropboxApiError && isReset(error)) {
        const next = await this.snapshot(root)
        const changes =
          decoded.snapshot === null
            ? []
            : diffSnapshots(root, decoded.snapshot, next.snapshot, next.entries, observed)
        return new Delta({ changes, checkpoint: encode(next.cursor, next.snapshot) })
      }
      throw error
    }
  }
}

export function buildDeltaHook(accessor: DropboxAccessor): DeltaHook {
  return new DropboxDeltaHook(accessor)
}
