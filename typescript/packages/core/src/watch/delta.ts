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
import { rstripSlash, stripSlash } from '../utils/slash.ts'

export function specFor(root: PathSpec, virtual: string): PathSpec {
  const cut = rstripSlash(root.virtual).length - root.vfsPath.length
  return PathSpec.fromStrPath(virtual, stripSlash(virtual.slice(cut)))
}

/**
 * The changes a watch on `root` reports (`eventsUnder`), from each change and
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
 * The events a watch on `root` reports: each at or below it as itself, and
 * each at a directory above it as the root's own, since that directory removed
 * removes the root, and any other change to it may have moved the root
 * (UNKNOWN). A move out of the root is a delete where it was. Mirrors Python
 * `events_under`.
 */
export function eventsUnder(root: PathSpec, events: Iterable<FileEvent>): FileEvent[] {
  const top = rstripSlash(root.virtual)
  const inside = (virtual: string): boolean => virtual === top || virtual.startsWith(`${top}/`)
  const kept: FileEvent[] = []
  for (const event of events) {
    const virtual = event.path.virtual
    const previous = event.previousPath
    if (inside(virtual)) {
      kept.push(event)
    } else if (previous !== null && inside(previous.virtual)) {
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
 * Move each placed path below the folder `was` under `now`, or forget it when
 * `now` is null. Mirrors Python `moved_below`.
 */
export function movedBelow(seen: Record<string, string>, was: string, now: string | null): void {
  for (const [itemId, path] of Object.entries(seen)) {
    if (!path.startsWith(`${was}/`)) continue
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
