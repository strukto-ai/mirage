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
import { Delta, FileChangeKind, type PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { changesUnder } from '../../watch/delta.ts'
import { virtualOf } from '../../watch/events.ts'
import { continueFolder, latestCursor, type DropboxEntry } from './api.ts'
import { DropboxApiError } from './client.ts'
import { dropboxPathOf } from './paths.ts'

function isReset(err: unknown): boolean {
  return err instanceof DropboxApiError && err.status === 409 && err.summary.startsWith('reset')
}

/**
 * A listing row's mount-relative path, or null for the mount root.
 *
 * Dropbox paths are case-insensitive: `path_display` carries the server's
 * casing while `rootPath` carries the user's, so the root is stripped
 * case-folded and the rest keeps the server's casing, which is safe because
 * `path_lower` is `path_display` lowercased, same length. Mirrors Python
 * `_relative`.
 */
function relativeOf(accessor: DropboxAccessor, entry: DropboxEntry): string | null {
  const display = entry.path_display ?? entry.path_lower
  if (display === undefined || display === '') return null
  const base = accessor.rootPath
  const relative =
    base !== '' && display.toLowerCase().startsWith(base.toLowerCase())
      ? display.slice(base.length)
      : display
  const stripped = relative.replace(/^\/+|\/+$/g, '')
  return stripped === '' ? null : stripped
}

function encode(cursor: string, seen: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.entries(seen).sort(([a], [b]) => compareCodePoints(a, b)),
  )
  return JSON.stringify({ dropbox: { cursor, seen: sorted } })
}

/** The cursor and seen paths a checkpoint holds, null for a baseline. */
function decode(checkpoint: string | null): [string, Record<string, string>] | null {
  if (checkpoint === null) return null
  const data = JSON.parse(checkpoint) as {
    dropbox?: { cursor?: string; seen?: Record<string, string> }
  }
  const state = data.dropbox ?? {}
  return [state.cursor ?? '', { ...(state.seen ?? {}) }]
}

function dropBelow(seen: Record<string, string>, relative: string): void {
  for (const key of Object.keys(seen)) {
    if (key === relative || key.startsWith(`${relative}/`)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete seen[key]
    }
  }
}

/**
 * What changed under a Dropbox watch root since the last cursor, for the
 * consumer to call when Dropbox pings.
 *
 * Dropbox's push (a webhook, or `list_folder/longpoll` answering `changes`)
 * names only the account, so each ping is answered by one
 * `list_folder/continue` from the stored cursor. A baseline takes a cursor at
 * the present with `get_latest_cursor` and lists nothing.
 *
 * A row names its path, so a delete is a DELETE where it was, and a move is
 * its old path deleted and its new rows. A row does not say whether a file was
 * made or replaced, so the checkpoint keeps each path a pull has reported with
 * its `content_hash`: a path seen before is an UPDATE, or nothing when its
 * content did not change, and any other is a CREATE. A cursor Dropbox resets
 * answers UNKNOWN on the watch root and a fresh cursor; a root Dropbox cannot
 * find has no cursor, and the pull that finds it again reports the root
 * UNKNOWN.
 *
 * Mirrors Python `DropboxDeltaHook` (`core/dropbox/watch.py`).
 */
export class DropboxDeltaHook implements DeltaHook {
  private readonly accessor: DropboxAccessor

  constructor(accessor: DropboxAccessor) {
    this.accessor = accessor
  }

  /** A cursor at the root's present, '' when Dropbox cannot find it. */
  private async latest(root: PathSpec): Promise<string> {
    try {
      return await latestCursor(this.accessor.tokenManager, dropboxPathOf(this.accessor, root), {
        recursive: true,
      })
    } catch (err) {
      if (!(err instanceof DropboxApiError) || err.status !== 409) throw err
      console.debug(`dropbox watch root has no cursor: ${err.message}`)
      return ''
    }
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const state = decode(checkpoint)
    const observed = new Date()
    const lost: [FileChangeKind, string][] = [[FileChangeKind.UNKNOWN, root.virtual]]
    if (state === null)
      return new Delta({ changes: [], checkpoint: encode(await this.latest(root), {}) })
    let [cursor] = state
    const seen = state[1]
    if (cursor === '') {
      cursor = await this.latest(root)
      const changes = cursor !== '' ? changesUnder(root, lost, observed) : []
      return new Delta({ changes, checkpoint: encode(cursor, {}) })
    }
    let rows: DropboxEntry[]
    try {
      ;({ entries: rows, cursor } = await continueFolder(this.accessor.tokenManager, cursor))
    } catch (err) {
      if (!isReset(err)) throw err
      console.debug(`dropbox cursor reset: ${String(err)}`)
      const fresh = await this.latest(root)
      return new Delta({
        changes: changesUnder(root, lost, observed),
        checkpoint: encode(fresh, {}),
      })
    }
    const found: [FileChangeKind, string][] = []
    for (const row of rows) {
      const relative = relativeOf(this.accessor, row)
      if (relative === null) continue
      const virtual = virtualOf(root, relative)
      const tag = row['.tag']
      if (tag === 'deleted') {
        dropBelow(seen, relative)
        found.push([FileChangeKind.DELETE, virtual])
        continue
      }
      const version = tag === 'folder' ? '' : (row.content_hash ?? row.rev ?? '')
      const previous = Object.hasOwn(seen, relative) ? seen[relative] : undefined
      seen[relative] = version
      if (previous === undefined) found.push([FileChangeKind.CREATE, virtual])
      else if (previous !== version) found.push([FileChangeKind.UPDATE, virtual])
    }
    return new Delta({
      changes: changesUnder(root, found, observed),
      checkpoint: encode(cursor, seen),
    })
  }
}

export function buildDeltaHook(accessor: DropboxAccessor): DeltaHook {
  return new DropboxDeltaHook(accessor)
}
