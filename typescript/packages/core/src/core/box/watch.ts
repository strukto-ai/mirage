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

import type { BoxAccessor } from '../../accessor/box.ts'
import {
  Delta,
  FileChangeKind,
  type FileEvent,
  type JsonValue,
  type PathSpec,
  type WalkEntry,
} from '../../types.ts'
import { isEnoent } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { DIR_FINGERPRINT } from '../../watch/constants.ts'
import { diffSnapshots } from '../../watch/delta.ts'
import { eventAt, field, virtualOf } from '../../watch/events.ts'
import { statFingerprint } from '../../watch/fingerprint.ts'
import {
  absentOn404,
  eventsNow,
  eventsSince,
  listFolderItems,
  type BoxEvent,
  type BoxItem,
  type BoxSearchItem,
} from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { EVENT_REPLAY_DAYS, EVENT_STREAM, PLACE_EVENTS, TRASH_EVENTS } from './constants.ts'
import { mountRelativeKey, pathParts, resolveChain } from './resolve.ts'

const NATIVE = 1
const DAY_MS = 24 * 60 * 60 * 1000

type BoxSource = BoxItem & Pick<BoxSearchItem, 'path_collection'>

/**
 * The key an item is remembered by: its type and its Box id.
 *
 * Files and folders are addressed through separate endpoints, and nothing
 * promises their ids never coincide, so the type rides along.
 */
function refOf(item: { type: string; id: string }): string {
  return `${item.type}:${item.id}`
}

/** Whether `key` lies strictly below `place`. */
function under(key: string, place: string): boolean {
  return key.startsWith(`${rstripSlash(place)}/`)
}

/** Whether `key` is `place` or lies below it. */
function inside(key: string, place: string): boolean {
  return key === place || under(key, place)
}

/** `key` moved from under `old` to under `next`, if it was there. */
function rebase(key: string, old: string, next: string): string {
  return inside(key, old) ? next + key.slice(old.length) : key
}

/**
 * One walk row for a Box item, fingerprinted the way stat does.
 *
 * The fingerprint matches what `ReaddirWalk` built from Box stat, so a
 * listing-era checkpoint upgrades without reporting every file.
 */
function entryOf(virtual: string, item: BoxItem): WalkEntry {
  if (item.type === 'folder') return { virtual, isDir: true, fingerprint: null }
  const modified =
    item.modified_at !== undefined && item.modified_at !== '' ? item.modified_at : null
  const size = typeof item.size === 'number' ? item.size : null
  const sha1 = item.sha1 !== undefined && item.sha1 !== '' ? item.sha1 : null
  return {
    virtual,
    isDir: false,
    fingerprint: statFingerprint(sha1 ?? modified, modified, size),
    size,
    modified,
  }
}

/**
 * Yield [ref, entry] for everything under one folder.
 *
 * Web links are skipped, as readdir hides them. A folder removed mid-walk is
 * skipped; the next pull settles it.
 */
async function* walk(
  tm: BoxTokenManager,
  folderId: string,
  virtual: string,
): AsyncGenerator<[string, WalkEntry]> {
  let items: BoxItem[]
  try {
    items = await absentOn404(virtual, () => listFolderItems(tm, folderId))
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  for (const item of items) {
    if (item.type !== 'file' && item.type !== 'folder') continue
    const child = `${rstripSlash(virtual)}/${item.name}`
    yield [refOf(item), entryOf(child, item)]
    if (item.type === 'folder') yield* walk(tm, item.id, child)
  }
}

/**
 * The last applied snapshot, plus the item behind each path.
 *
 * Events name items by id, and neither a move nor a trash says where the item
 * was, so the ref map is what finds the old path. A file is one key; a folder
 * is its whole subtree, which Box sends no events for.
 */
class Tree {
  snapshot: Map<string, string>
  refs: Map<string, string>
  readonly entries = new Map<string, WalkEntry>()

  constructor(snapshot: Record<string, string>, refs: Record<string, string>) {
    this.snapshot = new Map(Object.entries(snapshot))
    this.refs = new Map(Object.entries(refs))
  }

  /** Record an item at its path. */
  put(ref: string, entry: WalkEntry): void {
    this.snapshot.set(entry.virtual, entry.isDir ? DIR_FINGERPRINT : (entry.fingerprint ?? ''))
    this.refs.set(ref, entry.virtual)
    this.entries.set(entry.virtual, entry)
  }

  /** Forget an item, and a folder's subtree with it. */
  drop(ref: string, virtual: string): void {
    if (this.snapshot.get(virtual) !== DIR_FINGERPRINT) {
      this.snapshot.delete(virtual)
      this.refs.delete(ref)
      return
    }
    this.snapshot = new Map([...this.snapshot].filter(([key]) => !inside(key, virtual)))
    this.refs = new Map([...this.refs].filter(([, key]) => !inside(key, virtual)))
  }

  /** Carry a folder and its subtree from `old` to `next`. */
  move(old: string, next: string): void {
    this.snapshot = new Map(
      [...this.snapshot].map(([key, value]) => [rebase(key, old, next), value]),
    )
    this.refs = new Map([...this.refs].map(([ref, key]) => [ref, rebase(key, old, next)]))
  }
}

/** What a native checkpoint carries next to its snapshot. */
interface Native {
  /** Stream position the next read starts from. */
  position: string
  /** When the snapshot was last walked. */
  walked: Date
  /** `{ref: virtual}` for the snapshot. */
  refs: Record<string, string>
  /**
   * Folder ids from the mount root down to the watch root, as far as the last
   * walk resolved it.
   */
  chain: string[]
}

function sorted(map: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of [...map.keys()].sort(compareCodePoints)) {
    const value = map.get(key)
    if (value !== undefined) out[key] = value
  }
  return out
}

function encode(position: string, walked: Date, tree: Tree, chain: readonly string[]): string {
  return JSON.stringify({
    _box: NATIVE,
    i: sorted(tree.refs),
    p: position,
    r: [...chain],
    s: sorted(tree.snapshot),
    w: walked.toISOString(),
  })
}

/**
 * Return the last snapshot and the native state.
 *
 * A listing-era checkpoint is a bare `{virtual: fingerprint}` map with no
 * stream position; it is diffed against a fresh walk once and upgraded.
 */
function decode(checkpoint: string | null): {
  previous: Record<string, string> | null
  native: Native | null
} {
  if (checkpoint === null) return { previous: null, native: null }
  const parsed: unknown = JSON.parse(checkpoint)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { previous: null, native: null }
  }
  const data = parsed as Record<string, unknown>
  if (data._box !== NATIVE) return { previous: data as Record<string, string>, native: null }
  return {
    previous: data.s as Record<string, string>,
    native: {
      position: data.p as string,
      walked: new Date(data.w as string),
      refs: data.i as Record<string, string>,
      chain: data.r as string[],
    },
  }
}

/**
 * The file or folder an event is about, or null.
 *
 * User events carry the full item as `source`, with the `path_collection`
 * that places it. Web links, users and collaborations are not paths on the
 * mount.
 */
function sourceOf(value: unknown): BoxSource | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Partial<BoxSource>
  if (source.type !== 'file' && source.type !== 'folder') return null
  if (typeof source.id !== 'string' || source.id === '') return null
  return source as BoxSource
}

/**
 * Each event once, in the order it happened.
 *
 * Box may send an event more than once or out of order: a repeat carries the
 * same `event_id`, and `created_at` gives the order. A tie keeps the order Box
 * sent, and an event with no stamp stays behind the one before it.
 */
function ordered(events: readonly BoxEvent[]): BoxEvent[] {
  const seen = new Set<string>()
  const stamped: { stamp: number; event: BoxEvent }[] = []
  let stamp = Number.NEGATIVE_INFINITY
  for (const event of events) {
    const eventId = event.event_id
    if (eventId !== undefined && eventId !== '') {
      if (seen.has(eventId)) continue
      seen.add(eventId)
    }
    const created = event.created_at === undefined ? Number.NaN : Date.parse(event.created_at)
    if (!Number.isNaN(created)) stamp = created
    stamped.push({ stamp, event })
  }
  stamped.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0))
  return stamped.map((row) => row.event)
}

/**
 * Box `/events` pull, with the per-folder walk as reset.
 *
 * The user event stream is account-wide, so every event is placed through its
 * `path_collection` and dropped unless it lands under the watch root. A move
 * arrives as one `ITEM_MOVE` (or `ITEM_RENAME`) naming only the new location,
 * and a trashed item's place is the Trash, which is why the checkpoint keeps
 * the item behind each path next to the snapshot: its ref finds the old path,
 * and a moved folder carries its subtree with it. A folder that shows up
 * already populated (a copy, a restore, a move in from outside the root) is
 * walked, since Box sends one event for the folder and none for what is
 * inside.
 *
 * The snapshot is keyed by path from the watch root down, so an event that
 * moves, trashes or restores the watch root or a folder above it, or lands a
 * folder on the watch root's path, changes where every entry is. The
 * checkpoint keeps the ids of that chain of folders, and such an event walks
 * again instead of being applied.
 *
 * Box never refuses an old `stream_position`: user events are kept for two
 * weeks to two months, and a stale position replays whatever is left. It may
 * also send an event twice or out of order; a pull applies its events once
 * each in `created_at` order, but one that arrives a pull late can still leave
 * a path wrong. So the walk also runs once the snapshot was walked more than
 * `EVENT_REPLAY_DAYS` ago, which bounds both. It reads the stream head before
 * it lists, so a write that lands mid-walk is replayed by the next pull rather
 * than lost; the fingerprint diff discards the repeat.
 *
 * Only placements and trashes are applied, so a folder shared into or out of
 * the account through a collaboration surfaces at the next walk.
 */
export class BoxDeltaHook implements DeltaHook {
  private readonly accessor: BoxAccessor

  constructor(accessor: BoxAccessor) {
    this.accessor = accessor
  }

  /** Virtual path an event puts `item` at, or null off the mount. */
  private placeOf(root: PathSpec, item: BoxSource): string | null {
    const relative = mountRelativeKey(item, this.accessor.rootFolderId)
    return relative === null ? null : virtualOf(root, relative)
  }

  /**
   * Folder ids from the mount root down to the watch root.
   *
   * A component that is missing, or not a folder, ends the chain, so it
   * reaches the watch root only when there is a folder to walk.
   */
  private async chainOf(root: PathSpec): Promise<string[]> {
    const parts = pathParts(root)
    let found: BoxItem[]
    try {
      found = await absentOn404(root.virtual, () => resolveChain(this.accessor, parts))
    } catch (error) {
      if (!isEnoent(error)) throw error
      found = []
    }
    const chain = [this.accessor.rootFolderId]
    for (const item of found) {
      if (item.type !== 'folder') break
      chain.push(item.id)
    }
    return chain
  }

  /**
   * Whether `event` moves, removes or replaces the watch root.
   *
   * A folder of the chain that is trashed, or placed anywhere but its own spot
   * above the root, moves every path in the snapshot. Any other folder landing
   * on the root's path, or on a folder above it, may put a tree where the
   * snapshot has none.
   */
  private movesRoot(root: PathSpec, chain: readonly string[], event: BoxEvent): boolean {
    const source = sourceOf(event.source)
    const kind = event.event_type ?? ''
    if (source?.type !== 'folder' || (!PLACE_EVENTS.has(kind) && !TRASH_EVENTS.has(kind))) {
      return false
    }
    const place = this.placeOf(root, source)
    const depth = chain.indexOf(source.id)
    if (depth !== -1) {
      if (TRASH_EVENTS.has(kind)) return true
      return place !== virtualOf(root, pathParts(root).slice(0, depth).join('/'))
    }
    if (TRASH_EVENTS.has(kind) || place === null) return false
    return inside(virtualOf(root, root.vfsPath), place)
  }

  /** Walk `root` afresh, from the current stream head. */
  private async relist(
    root: PathSpec,
    previous: Record<string, string> | null,
    observed: Date,
  ): Promise<Delta> {
    const tm = this.accessor.tokenManager
    const position = await eventsNow(tm, EVENT_STREAM)
    const chain = await this.chainOf(root)
    const tree = new Tree({}, {})
    const folderId = chain[chain.length - 1]
    if (folderId !== undefined && chain.length > pathParts(root).length) {
      for await (const [ref, entry] of walk(tm, folderId, virtualOf(root, root.vfsPath))) {
        tree.put(ref, entry)
      }
    }
    const changes =
      previous === null
        ? []
        : diffSnapshots(root, previous, Object.fromEntries(tree.snapshot), tree.entries, observed)
    return new Delta({ changes, checkpoint: encode(position, observed, tree, chain) })
  }

  /** Bring the tree up to date with one event. */
  private async apply(root: PathSpec, here: string, tree: Tree, event: BoxEvent): Promise<void> {
    const source = sourceOf(event.source)
    if (source === null) return
    const ref = refOf(source)
    const kind = event.event_type ?? ''
    const old = tree.refs.get(ref)
    if (TRASH_EVENTS.has(kind)) {
      if (old !== undefined) tree.drop(ref, old)
      return
    }
    if (!PLACE_EVENTS.has(kind)) return
    let place = this.placeOf(root, source)
    if (place !== null && !under(place, here)) place = null
    const isDir = source.type === 'folder'
    if (old !== undefined && old !== place) {
      if (place !== null && isDir) {
        tree.move(old, place)
        return
      }
      tree.drop(ref, old)
    }
    if (place === null) return
    tree.put(ref, entryOf(place, source))
    if (isDir && old === undefined) {
      for await (const [childRef, entry] of walk(this.accessor.tokenManager, source.id, place)) {
        tree.put(childRef, entry)
      }
    }
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const { previous, native } = decode(checkpoint)
    const observed = new Date()
    const walked = native?.walked.getTime() ?? Number.NaN
    if (
      native === null ||
      Number.isNaN(walked) ||
      observed.getTime() - walked > EVENT_REPLAY_DAYS * DAY_MS
    ) {
      return this.relist(root, previous, observed)
    }
    const found = await eventsSince(this.accessor.tokenManager, native.position, EVENT_STREAM)
    const events = ordered(found.entries)
    if (events.some((event) => this.movesRoot(root, native.chain, event))) {
      return this.relist(root, previous, observed)
    }
    const here = virtualOf(root, root.vfsPath)
    const tree = new Tree(previous ?? {}, native.refs)
    for (const event of events) await this.apply(root, here, tree, event)
    return new Delta({
      changes: diffSnapshots(
        root,
        previous ?? {},
        Object.fromEntries(tree.snapshot),
        tree.entries,
        observed,
      ),
      checkpoint: encode(found.position, native.walked, tree, native.chain),
    })
  }
}

/**
 * Map one Box user event onto mount paths.
 *
 * The consumer owns the long poll: `realtimeServer` gives the URL, a
 * `new_change` answer means read `eventsSince` from the last position, and
 * each event read goes through `toEvents` with its `event_type`. Nothing here
 * runs a loop.
 *
 * An event names the item's new place only, and a trashed item's place is the
 * Trash, so the hook remembers where each item it has mapped was, and moves
 * or forgets a folder's contents along with it. An item it has never seen
 * gets the honest answer instead: a move or rename of one is UNKNOWN on the
 * directory it landed in, and a trash of one maps to nothing and rides the
 * index TTL, as Slack's unmapped deletes do. The pull (`BoxDeltaHook`) is the
 * truth path for both.
 *
 * A folder stands for everything below it, which Box sends no events for, so
 * a place a folder leaves or lands on is UNKNOWN, which takes the whole subtree
 * whatever the index holds; only a folder created empty (`ITEM_CREATE`) is a
 * CREATE. The mount root has no path of its own, so its trash or restore is
 * UNKNOWN on the whole mount.
 *
 * Upload of a new version and of a new file are the same `ITEM_UPLOAD`, so the
 * split between CREATE and UPDATE is also whether the item was seen before.
 */
export class BoxEventHook {
  private readonly accessor: BoxAccessor
  private paths = new Map<string, string>()

  constructor(accessor: BoxAccessor) {
    this.accessor = accessor
  }

  toEvents(root: PathSpec, eventType: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    return Promise.resolve(this.map(root, eventType, payload))
  }

  /** Forget an item that left the mount, and report where it was. */
  private leave(
    root: PathSpec,
    ref: string,
    old: string | undefined,
    isDir: boolean,
  ): readonly FileEvent[] {
    if (old === undefined) return []
    if (isDir) {
      this.paths = new Map([...this.paths].filter(([, path]) => !inside(path, old)))
      return [eventAt(root, old, FileChangeKind.UNKNOWN)]
    }
    this.paths.delete(ref)
    return [eventAt(root, old, FileChangeKind.DELETE)]
  }

  /** Follow an item that moved within the mount. */
  private move(
    root: PathSpec,
    ref: string,
    old: string,
    next: string,
    isDir: boolean,
  ): readonly FileEvent[] {
    if (isDir) {
      this.paths = new Map([...this.paths].map(([r, path]) => [r, rebase(path, old, next)]))
      return [
        eventAt(root, old, FileChangeKind.UNKNOWN),
        eventAt(root, next, FileChangeKind.UNKNOWN),
      ]
    }
    this.paths.set(ref, next)
    return [eventAt(root, next, FileChangeKind.MOVE, old)]
  }

  private map(root: PathSpec, eventType: string, payload: JsonValue): readonly FileEvent[] {
    const source = sourceOf(field(payload, 'source'))
    if (source === null) return []
    const isDir = source.type === 'folder'
    const mountRoot = this.accessor.rootFolderId
    if (isDir && source.id === mountRoot) {
      if (TRASH_EVENTS.has(eventType) || eventType === 'ITEM_UNDELETE_VIA_TRASH') {
        return [eventAt(root, '', FileChangeKind.UNKNOWN)]
      }
      return []
    }
    const ref = refOf(source)
    const old = this.paths.get(ref)
    if (TRASH_EVENTS.has(eventType)) return this.leave(root, ref, old, isDir)
    if (!PLACE_EVENTS.has(eventType)) return []
    const relative = mountRelativeKey(source, mountRoot)
    if (relative === null) return this.leave(root, ref, old, isDir)
    if (old !== undefined && old !== relative) return this.move(root, ref, old, relative, isDir)
    this.paths.set(ref, relative)
    if (old === undefined && (eventType === 'ITEM_MOVE' || eventType === 'ITEM_RENAME')) {
      const cut = relative.lastIndexOf('/')
      return [eventAt(root, cut === -1 ? '' : relative.slice(0, cut), FileChangeKind.UNKNOWN)]
    }
    let kind: FileChangeKind
    if (isDir) {
      kind = eventType === 'ITEM_CREATE' ? FileChangeKind.CREATE : FileChangeKind.UNKNOWN
    } else if (old !== undefined || eventType === 'ITEM_MAKE_CURRENT_VERSION') {
      kind = FileChangeKind.UPDATE
    } else {
      kind = FileChangeKind.CREATE
    }
    return [eventAt(root, relative, kind)]
  }
}

export function buildDeltaHook(accessor: BoxAccessor): DeltaHook {
  return new BoxDeltaHook(accessor)
}
