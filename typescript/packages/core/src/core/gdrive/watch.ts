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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { Delta, FileChangeKind, FileEvent, type PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { changesUnder, folderPath, justMade, movedBelow, settle } from '../../watch/delta.ts'
import { GoogleApiError, type TokenManager } from '../google/client.ts'
import {
  FOLDER_MIME,
  MIME_TO_EXT,
  getFile,
  listChanges,
  listFiles,
  listSharedDrives,
  startPageToken,
  type DriveFile,
} from '../google/drive.ts'
import { feedCheckpoint, feedState } from '../google/watch.ts'
import { uniqueSharedDriveName } from './readdir.ts'
import { rootContext } from './resolve.ts'

/**
 * Whether a changed item is a folder the hook places by name; a shared drive's
 * root is named by the root listing instead. Mirrors Python's `_is_folder`.
 */
function isFolder(item: DriveFile): boolean {
  if (item.mimeType !== FOLDER_MIME) return false
  return !(item.driveId !== undefined && item.driveId !== '' && (item.parents ?? []).length === 0)
}

/** The name the listing gives `item`. */
function filenameOf(item: DriveFile): string {
  return item.name + (MIME_TO_EXT[item.mimeType ?? ''] ?? '')
}

/**
 * Where items sit on a Drive mount, found by their parents up to the mount
 * root, for one read. Each folder looked up is kept (name and parent, by id)
 * in `folders`, which the checkpoint carries to the next read. Mirrors
 * Python's `_Places`.
 */
class Places {
  readonly folders: Record<string, [string, string]>
  private readonly tm: TokenManager
  private readonly top: string
  private readonly scoped: boolean
  private drives: Map<string, string> | null = null
  private readonly driveRoots = new Set<string>()

  constructor(
    tm: TokenManager,
    top: string,
    scoped: boolean,
    folders: Record<string, [string, string]>,
  ) {
    this.tm = tm
    this.top = top
    this.scoped = scoped
    this.folders = folders
  }

  /**
   * The folders the checkpoint carries: every one looked up but a shared
   * drive's root, whose name the root listing assigns afresh whenever My
   * Drive's own top entries change.
   */
  kept(): Record<string, [string, string]> {
    return Object.fromEntries(
      Object.entries(this.folders).filter(([id]) => !this.driveRoots.has(id)),
    )
  }

  /** The mount path of the folder an item sits in, '' for the root, null outside. */
  async under(parents: readonly string[]): Promise<string | null> {
    const parent = parents[0]
    if (parent === undefined) return null
    if (parent === this.top) return ''
    return this.folder(parent)
  }

  /** The mount path of a folder, null when it is outside the mount. */
  folder(folderId: string): Promise<string | null> {
    return folderPath(folderId, this.top, this.folders, (id) => this.lookUp(id))
  }

  /**
   * A folder's name and parent, null when it is gone; a shared drive's root
   * sits under an unscoped mount's root by the name its listing gives it, and
   * nowhere on a scoped one.
   */
  private async lookUp(folderId: string): Promise<[string, string] | null> {
    let item: DriveFile
    try {
      item = await getFile(this.tm, folderId)
    } catch (err) {
      if (!(err instanceof GoogleApiError) || err.status !== 404) throw err
      console.debug(`drive folder ${folderId} is gone: ${err.message}`)
      return null
    }
    const parents = item.parents ?? []
    if (item.driveId !== undefined && item.driveId !== '' && parents.length === 0) {
      this.driveRoots.add(folderId)
      const name = this.scoped ? '' : await this.driveName(folderId)
      return [name, name !== '' ? this.top : '']
    }
    return [item.name, parents[0] ?? '']
  }

  /** The name the root listing gives a shared drive, '' when it is no longer listed. */
  private async driveName(driveId: string): Promise<string> {
    if (this.drives === null) {
      const taken = new Set((await listFiles(this.tm, { folderId: 'root' })).map(filenameOf))
      this.drives = new Map()
      for (const drive of await listSharedDrives(this.tm)) {
        const name = uniqueSharedDriveName(drive.name, taken)
        taken.add(name)
        this.drives.set(drive.id, name)
      }
    }
    return this.drives.get(driveId) ?? ''
  }
}

/** The virtual path of a mount-relative path. */
function virtualAt(prefix: string, relative: string): string {
  if (relative !== '') return `${prefix}/${relative}`
  return prefix === '' ? '/' : prefix
}

/**
 * Checkpointed delta over Drive's change feed.
 *
 * Drive pings a channel with no body, so a ping reads `changes.list` from the
 * page token the last read handed out. A change names an item by id, with its
 * name and parents, so the hook places it by its parents up to the mount
 * root, keeping each folder it has looked up (name and parent, by id) in the
 * checkpoint, where the folders' own changes keep them current. An item whose
 * parents never reach the root is outside the mount. The checkpoint also keeps
 * the path of each item a read placed: one that moves leaves that path, with
 * everything below a folder, and one deleted, trashed or no longer shared
 * leaves it. An item seen for the first time is created when it is as Drive
 * made it (its created and modified times agree) and updated otherwise; one
 * removed before any read
 * placed it names nothing, and is left to the index's expiry. On an unscoped
 * mount, whose root lists the shared drives, a shared drive made, renamed or
 * left reports the root as unknown. Each read first applies the feed's folder
 * renames and moves, so an item listed before its folder is still placed where
 * the folder is now, and a shared drive is named afresh each read, as the root
 * listing may rename it.
 *
 * Mirrors Python `GDriveDeltaHook` (`core/gdrive/watch.py`).
 */
export class GDriveDeltaHook implements DeltaHook {
  private readonly accessor: GDriveAccessor

  constructor(accessor: GDriveAccessor) {
    this.accessor = accessor
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const tm = this.accessor.tokenManager
    const observed = new Date()
    const [folderId] = await rootContext(this.accessor)
    const scoped = folderId !== 'root'
    const state = feedState(checkpoint)
    if (state === null) {
      const token = await startPageToken(tm)
      const top = scoped ? folderId : (await getFile(tm, 'root')).id
      return new Delta({ changes: [], checkpoint: encode(token, top, {}, {}) })
    }
    const [found, token] = await listChanges(tm, state.token)
    const prefix = rstripSlash(mountPrefixOf(root.virtual, root.vfsPath))
    const top = String(state.root)
    const places = new Places(tm, top, scoped, { ...(state.folders ?? {}) })
    const seen: Record<string, string> = { ...(state.seen ?? {}) }
    const changes: [FileChangeKind, string][] = []
    let unknown = false
    const entries: [string, DriveFile | null, boolean][] = []
    for (const change of found) {
      if (change.changeType === 'drive') {
        unknown ||= !scoped
        continue
      }
      const itemId = change.fileId
      if (typeof itemId !== 'string') continue
      const item = change.file ?? null
      const gone = change.removed === true || item === null || item.trashed === true
      if (itemId === top) {
        if (gone) changes.push([FileChangeKind.DELETE, prefix === '' ? '/' : prefix])
        continue
      }
      entries.push([itemId, item, gone])
    }
    for (const [itemId] of entries) {
      if (!Object.hasOwn(seen, itemId) && Object.hasOwn(places.folders, itemId)) {
        const placed = await places.folder(itemId)
        if (placed !== null) seen[itemId] = virtualAt(prefix, placed)
      }
    }
    for (const [itemId, item, gone] of entries) {
      if (item !== null && isFolder(item)) {
        places.folders[itemId] = [item.name, item.parents?.[0] ?? '']
      } else if (gone) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete places.folders[itemId]
      }
    }
    const moves = new Map<string, string | null>()
    for (const [itemId, item, gone] of entries) {
      let where: string | null = null
      if (item !== null) {
        const base = await places.under(item.parents ?? [])
        if (base !== null) {
          const name = filenameOf(item)
          where = virtualAt(prefix, base !== '' ? `${base}/${name}` : name)
        }
      }
      if (gone && where !== null && !Object.hasOwn(seen, itemId)) seen[itemId] = where
      const now = gone ? null : where
      const made = item !== null && justMade(item.createdTime, item.modifiedTime)
      const was = settle(changes, seen, itemId, now, made)
      if (was !== null && was !== now) moves.set(was, now)
    }
    movedBelow(seen, moves, new Set(entries.map(([itemId]) => itemId)))
    const events = changesUnder(root, changes, observed)
    if (unknown) {
      events.push(new FileEvent({ kind: FileChangeKind.UNKNOWN, path: root, timestamp: observed }))
    }
    return new Delta({
      changes: events,
      checkpoint: encode(token, top, places.kept(), seen),
    })
  }
}

/** Encode the state the next read starts from. Mirrors Python's `_checkpoint`. */
function encode(
  token: string,
  top: string,
  folders: Record<string, [string, string]>,
  seen: Record<string, string>,
): string {
  return feedCheckpoint({ token, root: top, folders, seen })
}

export function buildDeltaHook(accessor: GDriveAccessor): DeltaHook {
  return new GDriveDeltaHook(accessor)
}
