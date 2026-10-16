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

import { FileChangeKind, FileEvent, PathSpec } from '../types.ts'
import { rekey, underPath } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'

export function specFor(root: PathSpec, virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual, rekey(root.virtual, root.vfsPath, virtual))
}

/**
 * The event saying what changed under `root` is not known: UNKNOWN on the
 * root, which the hub reads as "re-inventory everything below". Mirrors
 * Python `lost_at`.
 */
export function lostAt(root: PathSpec, observed: Date): FileEvent {
  return new FileEvent({ kind: FileChangeKind.UNKNOWN, path: root, timestamp: observed })
}

/**
 * How one item's paths moved: each path it left, each it reached, and each it
 * kept that `updated` says changed. Mirrors Python `changes_between`.
 */
export function changesBetween(
  before: readonly string[],
  after: readonly string[],
  updated: (path: string) => boolean,
): [FileChangeKind, string][] {
  const kept = new Set(before.filter((path) => after.includes(path)))
  const changes: [FileChangeKind, string][] = []
  for (const path of before) if (!kept.has(path)) changes.push([FileChangeKind.DELETE, path])
  for (const path of after) if (!kept.has(path)) changes.push([FileChangeKind.CREATE, path])
  for (const path of after)
    if (kept.has(path) && updated(path)) changes.push([FileChangeKind.UPDATE, path])
  return changes
}

/**
 * The changes a subscription to `root` reports (`eventsUnder`), from each change and
 * the virtual path it is at. Mirrors Python `changes_under`.
 */
export function changesUnder(
  root: PathSpec,
  changes: Iterable<readonly [FileChangeKind, string]>,
  observed: Date,
): FileEvent[] {
  const events: FileEvent[] = []
  for (const [kind, virtual] of changes) {
    events.push(new FileEvent({ kind, path: specFor(root, virtual), timestamp: observed }))
  }
  return eventsUnder(root, events)
}

/**
 * The events a subscription to `root` reports: each at or below it as itself, and
 * each at a directory above it as the root's own, since that directory removed
 * removes the root, and any other change to it may have moved the root
 * (UNKNOWN). A move out of the root is a delete where it was. Mirrors Python
 * `events_under`.
 */
export function eventsUnder(root: PathSpec, events: Iterable<FileEvent>): FileEvent[] {
  const top = rstripSlash(root.virtual)
  const kept: FileEvent[] = []
  for (const event of events) {
    const virtual = event.path.virtual
    const previous = event.previousPath
    if (underPath(virtual, top)) {
      kept.push(event)
    } else if (previous !== null && underPath(previous.virtual, top)) {
      kept.push(
        new FileEvent({
          kind: FileChangeKind.DELETE,
          path: previous,
          timestamp: event.timestamp,
        }),
      )
    } else if (top.startsWith(`${rstripSlash(virtual)}/`)) {
      const gone = event.kind === FileChangeKind.DELETE
      kept.push(
        new FileEvent({
          kind: gone ? event.kind : FileChangeKind.UNKNOWN,
          path: root,
          timestamp: event.timestamp,
        }),
      )
    }
  }
  return kept
}

/**
 * Record how one item of a feed that names items by id moved from where the
 * last read placed it to `now`, and return where it was.
 *
 * An item seen before leaves its old path when it moved and is updated in
 * place otherwise; one not seen before is created when it is as the service
 * made it and updated otherwise, since where it was is not known.
 * Mirrors Python `settle`.
 */
export function settle(
  changes: [FileChangeKind, string][],
  seen: Record<string, string>,
  itemId: string,
  now: string | null,
  made: boolean,
): string | null {
  const was = Object.hasOwn(seen, itemId) ? (seen[itemId] ?? null) : null
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete seen[itemId]
  if (now === null) {
    if (was !== null) changes.push([FileChangeKind.DELETE, was])
    return was
  }
  seen[itemId] = now
  if (was === null) {
    changes.push([made ? FileChangeKind.CREATE : FileChangeKind.UPDATE, now])
  } else if (was !== now) {
    changes.push([FileChangeKind.DELETE, was])
    changes.push([FileChangeKind.CREATE, now])
  } else {
    changes.push([FileChangeKind.UPDATE, now])
  }
  return was
}

/**
 * Carry each kept path below a folder that moved to the folder's new path, or
 * forget it when the folder left.
 *
 * The moves of one read apply at once, each path by the deepest folder it was
 * below, so a folder that takes another's old name does not pull in what the
 * other held. Paths the read placed itself are where their items are now and
 * stay as they are. Mirrors Python `moved_below`.
 */
export function movedBelow(
  seen: Record<string, string>,
  moves: ReadonlyMap<string, string | null>,
  placed: ReadonlySet<string>,
): void {
  for (const [itemId, path] of Object.entries(seen)) {
    if (placed.has(itemId)) continue
    let was: string | null = null
    for (const old of moves.keys()) {
      if (path.startsWith(`${old}/`) && (was === null || old.length > was.length)) was = old
    }
    if (was === null) continue
    const now = moves.get(was) ?? null
    if (now === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete seen[itemId]
    } else {
      seen[itemId] = now + path.slice(was.length)
    }
  }
}

/**
 * Whether an item is as it was made: its creation and last modification
 * times, both the service's own clock, agree. Mirrors Python `just_made`.
 */
export function justMade(
  created: string | null | undefined,
  modified: string | null | undefined,
): boolean {
  if (created === null || created === undefined || created === '') return false
  if (modified === null || modified === undefined || modified === '') return false
  return Date.parse(created) === Date.parse(modified)
}

/**
 * The path of a folder below the folder `top` by each folder's name and
 * parent, '' for `top` itself, null when its parents never reach `top`. Each
 * folder looked up is added to `folders`; a parent of '' is outside. Mirrors
 * Python `folder_path`.
 */
export async function folderPath(
  folderId: string,
  top: string,
  folders: Record<string, [string, string]>,
  lookUp: (folderId: string) => Promise<[string, string] | null>,
): Promise<string | null> {
  const names: string[] = []
  const visited = new Set<string>()
  let current = folderId
  while (current !== top) {
    if (visited.has(current)) return null
    visited.add(current)
    let entry = Object.hasOwn(folders, current) ? folders[current] : undefined
    if (entry === undefined) {
      const found = await lookUp(current)
      if (found === null) return null
      folders[current] = found
      entry = found
    }
    if (entry[1] === '') return null
    names.push(entry[0])
    current = entry[1]
  }
  return names.reverse().join('/')
}
