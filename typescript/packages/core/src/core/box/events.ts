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
} from '../../types.ts'
import { underPath } from '../../utils/key_prefix.ts'
import { sortedJson } from '../../utils/sort.ts'
import type { DeltaHook } from '../../events/base.ts'
import { eventsUnder, lostAt } from '../../events/delta.ts'
import { eventAt, field } from '../../events/payload.ts'
import { eventsNow, eventsSince, type BoxEvent, type BoxItem, type BoxSearchItem } from './api.ts'
import { EVENT_REPLAY_DAYS, EVENT_STREAM, PLACE_EVENTS, TRASH_EVENTS } from './constants.ts'
import { mountRelativeKey } from './resolve.ts'

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

/** `key` moved from under `old` to under `next`, if it was there. */
function rebase(key: string, old: string, next: string): string {
  return underPath(key, old) ? next + key.slice(old.length) : key
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
 * What changed on a Box mount since the last stream position, for the
 * consumer to call when Box pings.
 *
 * Box's push (`realtime_server`'s long poll answering `new_change`) carries no
 * change, so each ping is answered by one read of the user event stream from
 * the stored position, each event mapped as `BoxEventHook` maps it, with the
 * places it remembers kept in the checkpoint. A baseline takes the stream's
 * present position and lists nothing.
 *
 * Box never refuses an old `stream_position`: user events are kept for two
 * weeks to two months, and a stale position replays whatever is left, so a
 * checkpoint older than `EVENT_REPLAY_DAYS` answers UNKNOWN on the event root
 * and starts again at the present. Box may also send an event twice or out of
 * order, so each pull maps its events once each, in `created_at` order.
 *
 * Mirrors Python `BoxDeltaHook` (`core/box/events.py`).
 */
export class BoxDeltaHook implements DeltaHook {
  private readonly accessor: BoxAccessor

  constructor(accessor: BoxAccessor) {
    this.accessor = accessor
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const tm = this.accessor.tokenManager
    const state = decode(checkpoint)
    const observed = new Date()
    if (state === null) {
      const position = await eventsNow(tm, EVENT_STREAM)
      return new Delta({ changes: [], checkpoint: encode(position, observed, {}) })
    }
    if (observed.getTime() - state.read.getTime() > EVENT_REPLAY_DAYS * DAY_MS) {
      const fresh = await eventsNow(tm, EVENT_STREAM)
      return new Delta({
        changes: [lostAt(root, observed)],
        checkpoint: encode(fresh, observed, {}),
      })
    }
    const { entries, position } = await eventsSince(tm, state.position, EVENT_STREAM)
    const mapper = new BoxEventHook(this.accessor, state.paths)
    const events: FileEvent[] = []
    for (const event of ordered(entries)) {
      for (const item of await mapper.toEvents(root, event.event_type ?? '', event as JsonValue))
        events.push(item)
    }
    return new Delta({
      changes: eventsUnder(root, events),
      checkpoint: encode(position, observed, mapper.paths),
    })
  }
}

function encode(position: string, read: Date, paths: Readonly<Record<string, string>>): string {
  return sortedJson({ box: { paths, position, read: read.toISOString() } })
}

/**
 * The stream position, when it was read and the remembered places a
 * checkpoint holds, null for a baseline. Mirrors Python's `_decode`.
 */
function decode(
  checkpoint: string | null,
): { position: string; read: Date; paths: Record<string, string> } | null {
  if (checkpoint === null) return null
  const data = JSON.parse(checkpoint) as {
    box?: { position?: string; read?: string; paths?: Record<string, string> }
  }
  const state = data.box ?? {}
  return {
    position: state.position !== undefined && state.position !== '' ? state.position : 'now',
    read: new Date(state.read ?? ''),
    paths: { ...(state.paths ?? {}) },
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
 * index TTL, as Slack's unmapped deletes do.
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
  private places: Map<string, string>

  constructor(accessor: BoxAccessor, paths: Readonly<Record<string, string>> = {}) {
    this.accessor = accessor
    this.places = new Map(Object.entries(paths))
  }

  /** Where each item the hook has mapped is, by ref. */
  get paths(): Record<string, string> {
    return Object.fromEntries(this.places)
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
      this.places = new Map([...this.places].filter(([, path]) => !underPath(path, old)))
      return [eventAt(root, old, FileChangeKind.UNKNOWN)]
    }
    this.places.delete(ref)
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
      this.places = new Map([...this.places].map(([r, path]) => [r, rebase(path, old, next)]))
      return [
        eventAt(root, old, FileChangeKind.UNKNOWN),
        eventAt(root, next, FileChangeKind.UNKNOWN),
      ]
    }
    this.places.set(ref, next)
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
    const old = this.places.get(ref)
    if (TRASH_EVENTS.has(eventType)) return this.leave(root, ref, old, isDir)
    if (!PLACE_EVENTS.has(eventType)) return []
    const relative = mountRelativeKey(source, mountRoot)
    if (relative === null) return this.leave(root, ref, old, isDir)
    if (old !== undefined && old !== relative) return this.move(root, ref, old, relative, isDir)
    this.places.set(ref, relative)
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
