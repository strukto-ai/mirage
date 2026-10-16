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

import { Delta, FileChangeKind, type PathSpec } from '../../types.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { sortedJson } from '../../utils/sort.ts'
import type { DeltaHook } from '../../events/base.ts'
import { changesUnder, folderPath, justMade, movedBelow, settle } from '../../events/delta.ts'
import { encodedPath, GraphError, graphGet } from './client.ts'
import type { MsGraphConfigResolved } from './config.ts'
import { parentId } from './drive.ts'

/** One drive a delta pull reads, and where its mount root sits. Mirrors Python `DeltaTarget`. */
export interface DeltaTarget {
  /** The drive's Graph URL. */
  drive: string
  /** The mount root's path from the drive root, '' for the drive root itself. */
  folder: string
  /** The mount root's virtual path. */
  virtual: string
}

interface DriveState {
  virtual: string
  folder?: string
  top: string
  link: string
  folders: Record<string, [string, string]>
  seen: Record<string, string>
}

interface GraphItem {
  id?: string
  name?: string
  parentReference?: { id?: string }
  createdDateTime?: string
  lastModifiedDateTime?: string
  deleted?: unknown
  folder?: unknown
  root?: unknown
}

/**
 * Checkpointed delta over Graph's `/delta` feed, one per drive.
 *
 * Graph pings a subscription with no description of the change, so a ping
 * reads each drive's feed from the link the last read handed out. The feed
 * names an item by id with its name and parent, never its path, so the hook
 * places it by its parents up to the mount root, keeping each folder it has
 * looked up (name and parent, by id) in the checkpoint, where the folders' own
 * changes keep them current; an item whose parents never reach the root is
 * outside the mount. The checkpoint also keeps the path of each item a read
 * placed: one that moves leaves that path, with everything below a folder, and
 * one deleted leaves it. An item seen for the first time is created when it is
 * as Graph made it (its created and modified times agree) and updated
 * otherwise; one deleted before any
 * read placed it names nothing, and is left to the index's expiry. Each read
 * first applies the feed's folder renames and moves, so an item listed before
 * its folder is still placed where the folder is now. A feed Graph asks to
 * resync reports its mount root as unknown and starts again from the present,
 * forgetting every place it kept. Each read finds the drives the root covers
 * again: a library added since is created and read from then on, one gone is
 * deleted, and one renamed moves.
 *
 * Mirrors Python `GraphDeltaHook` (`core/msgraph/events.py`).
 */
export class GraphDeltaHook implements DeltaHook {
  private readonly config: MsGraphConfigResolved
  private readonly targets: (root: PathSpec) => Promise<DeltaTarget[]>

  constructor(config: MsGraphConfigResolved, targets: (root: PathSpec) => Promise<DeltaTarget[]>) {
    this.config = config
    this.targets = targets
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const observed = new Date()
    const state = decode(checkpoint)
    const targets = new Map((await this.targets(root)).map((t) => [t.drive, t]))
    if (state === null) {
      const drives: Record<string, DriveState> = {}
      for (const [drive, target] of targets) drives[drive] = await this.baseline(target)
      return new Delta({ changes: [], checkpoint: encode(drives) })
    }
    const changes: [FileChangeKind, string][] = []
    const drives = state.drives
    for (const drive of Object.keys(drives).filter((d) => !targets.has(d))) {
      const gone = drives[drive]
      if (gone !== undefined) changes.push([FileChangeKind.DELETE, gone.virtual])
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete drives[drive]
    }
    for (const [drive, target] of targets) {
      const kept = Object.hasOwn(drives, drive) ? drives[drive] : undefined
      if (kept === undefined) {
        drives[drive] = await this.baseline(target)
        changes.push([FileChangeKind.CREATE, target.virtual])
        continue
      }
      const old = kept.virtual
      if (old !== target.virtual) {
        changes.push([FileChangeKind.DELETE, old])
        changes.push([FileChangeKind.CREATE, target.virtual])
        movedBelow(kept.seen, new Map([[old, target.virtual]]), new Set())
        kept.virtual = target.virtual
      }
      await this.read(drive, kept, changes)
    }
    return new Delta({
      changes: changesUnder(root, changes, observed),
      checkpoint: encode(drives),
    })
  }

  /**
   * A drive's state at its present: the feed link that lists nothing yet, the
   * mount root's id, and nothing placed.
   */
  private async baseline(target: DeltaTarget): Promise<DriveState> {
    const top = await this.top(target.drive, target.folder)
    return {
      virtual: target.virtual,
      folder: target.folder,
      top: top ?? '',
      link: await this.latest(target.drive),
      folders: {},
      seen: {},
    }
  }

  /**
   * Read one drive's feed into `changes` and move `kept` on.
   *
   * A mount rooted below the drive root names its root by path, so each read
   * finds that folder again: one deleted, replaced or moved away (its own move
   * or an ancestor's) reports the root as unknown and starts placing items
   * afresh under whatever the path is now.
   */
  private async read(
    drive: string,
    kept: DriveState,
    changes: [FileChangeKind, string][],
  ): Promise<void> {
    const virtual = kept.virtual
    const folder = kept.folder ?? ''
    let items: GraphItem[]
    try {
      ;[items, kept.link] = await this.feed(kept.link)
    } catch (err) {
      if (!(err instanceof GraphError) || err.status !== 410) throw err
      console.debug(`graph feed of ${drive} must resync: ${err.message}`)
      changes.push([FileChangeKind.UNKNOWN, virtual])
      kept.top = (await this.top(drive, folder)) ?? ''
      kept.link = await this.latest(drive)
      kept.folders = {}
      kept.seen = {}
      return
    }
    if (folder !== '') {
      const top = (await this.top(drive, folder)) ?? ''
      if (top !== kept.top) {
        changes.push([FileChangeKind.UNKNOWN, virtual])
        kept.top = top
        kept.folders = {}
        kept.seen = {}
      }
    }
    const { top, folders, seen } = kept
    if (top === '') return
    const lookUp = (id: string): Promise<[string, string] | null> => this.lookUp(drive, id)
    const placed = items.filter(
      (item): item is GraphItem & { id: string } =>
        typeof item.id === 'string' && item.id !== top && item.root === undefined,
    )
    for (const item of placed) {
      if (!Object.hasOwn(seen, item.id) && Object.hasOwn(folders, item.id)) {
        const path = await folderPath(item.id, top, folders, lookUp)
        if (path !== null) seen[item.id] = join(virtual, path)
      }
    }
    for (const item of placed) {
      if (item.deleted !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete folders[item.id]
      } else if (item.folder !== undefined) {
        folders[item.id] = [item.name ?? '', parentId(item)]
      }
    }
    const moves = new Map<string, string | null>()
    for (const item of placed) {
      const parent = parentId(item)
      let now: string | null = null
      if (item.deleted === undefined && parent !== '') {
        const base = parent === top ? '' : await folderPath(parent, top, folders, lookUp)
        if (base !== null) {
          const name = item.name ?? ''
          now = join(virtual, base !== '' ? `${base}/${name}` : name)
        }
      }
      const made = justMade(item.createdDateTime, item.lastModifiedDateTime)
      const was = settle(changes, seen, item.id, now, made)
      if (was !== null && was !== now) moves.set(was, now)
    }
    movedBelow(seen, moves, new Set(placed.map((item) => item.id)))
  }

  /**
   * Every item a feed link lists, once each at its last row, and the link the
   * next read starts from. Graph may list an item more than once across pages;
   * its last row is its state.
   */
  private async feed(link: string): Promise<[GraphItem[], string]> {
    const items = new Map<string, GraphItem>()
    let url = link
    for (;;) {
      const data = await graphGet(this.config, url)
      const value = data.value
      for (const item of Array.isArray(value) ? (value as GraphItem[]) : []) {
        if (typeof item.id !== 'string') continue
        items.delete(item.id)
        items.set(item.id, item)
      }
      const delta = data['@odata.deltaLink']
      if (typeof delta === 'string' && delta !== '') return [[...items.values()], delta]
      url = String(data['@odata.nextLink'])
    }
  }

  /** A feed link at the drive's present, which lists nothing. */
  private async latest(drive: string): Promise<string> {
    const data = await graphGet(this.config, `${drive}/root/delta`, { token: 'latest' })
    return String(data['@odata.deltaLink'])
  }

  /** The id of the folder the mount root is, null when no folder is at its path. */
  private async top(drive: string, folder: string): Promise<string | null> {
    const path = stripSlash(folder)
    const url = path !== '' ? `${drive}/root:/${encodedPath(path)}` : `${drive}/root`
    try {
      const data = await graphGet(this.config, url, { $select: 'id' })
      return String(data.id)
    } catch (err) {
      if (!(err instanceof GraphError) || err.status !== 404) throw err
      console.debug(`graph mount root ${path} is gone: ${err.message}`)
      return null
    }
  }

  /**
   * A folder's name and parent id, null when it is gone; the drive root has
   * no parent on a mount rooted below it.
   */
  private async lookUp(drive: string, folderId: string): Promise<[string, string] | null> {
    let item: GraphItem
    try {
      item = (await graphGet(this.config, `${drive}/items/${encodeURIComponent(folderId)}`, {
        $select: 'id,name,parentReference,root',
      })) as GraphItem
    } catch (err) {
      if (!(err instanceof GraphError) || err.status !== 404) throw err
      console.debug(`graph folder ${folderId} is gone: ${err.message}`)
      return null
    }
    if (item.root !== undefined) return ['', '']
    return [item.name ?? '', parentId(item)]
  }
}

/** The virtual path of a path below a mount root. Mirrors Python's `_join`. */
function join(virtual: string, relative: string): string {
  if (relative === '') return virtual
  return `${rstripSlash(virtual)}/${relative}`
}

function encode(drives: Record<string, DriveState>): string {
  return sortedJson({ graph: { drives } })
}

/** What a checkpoint holds, null for a baseline. Mirrors Python's `_decode`. */
function decode(checkpoint: string | null): { drives: Record<string, DriveState> } | null {
  if (checkpoint === null) return null
  const data = JSON.parse(checkpoint) as { graph?: { drives?: unknown } } | null
  const drives = data?.graph?.drives
  if (drives === null || drives === undefined || typeof drives !== 'object') return null
  return { drives: drives as Record<string, DriveState> }
}
