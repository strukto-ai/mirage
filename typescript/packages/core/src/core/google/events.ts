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

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { Delta, type FileChangeKind, type PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DeltaHook } from '../../events/base.ts'
import { changesUnder, justMade, settle } from '../../events/delta.ts'
import { listChanges, startPageToken, type DriveFile } from './drive.ts'

/** What a Drive change-feed checkpoint holds. */
export interface FeedState {
  token: string
  seen?: Record<string, string>
  root?: string
  folders?: Record<string, [string, string]>
}

/** What a Drive change-feed checkpoint holds, null for a baseline. Mirrors Python `feed_state`. */
export function feedState(checkpoint: string | null): FeedState | null {
  if (checkpoint === null) return null
  const data = JSON.parse(checkpoint) as { drive?: Partial<FeedState> } | null
  const state = data?.drive
  if (state === undefined || typeof state.token !== 'string') return null
  return state as FeedState
}

/** Encode a Drive change-feed checkpoint. Mirrors Python `feed_checkpoint`. */
export function feedCheckpoint(state: FeedState): string {
  return JSON.stringify({ drive: state }, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareCodePoints(a, b)))
      : value,
  )
}

/**
 * Checkpointed delta of a Google app mount over Drive's change feed.
 *
 * Drive pings a channel with no body, so a ping reads `changes.list` from the
 * page token the last read handed out, keeping the changes to the app's files.
 * Each is placed as the app lists it: in `owned` or `shared` by its first
 * owner, named by its title, id and modified day. The checkpoint keeps the
 * path of each file a read placed, so an edit on another day or a new title
 * moves it from the name it had, and a file deleted, trashed or no longer
 * shared leaves it. A file seen for the first time is created when it is as
 * Drive made it (its created and modified times agree) and updated otherwise;
 * the name it had before is left to the corpus listing the update evicts.
 *
 * Mirrors Python `AppDeltaHook` (`core/google/events.py`).
 */
export class AppDeltaHook implements DeltaHook {
  private readonly accessor: GoogleApiAccessor
  private readonly mime: string
  private readonly makeFilename: (title: string, id: string, modified?: string) => string

  constructor(
    accessor: GoogleApiAccessor,
    mime: string,
    makeFilename: (title: string, id: string, modified?: string) => string,
  ) {
    this.accessor = accessor
    this.mime = mime
    this.makeFilename = makeFilename
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const tm = this.accessor.tokenManager
    const observed = new Date()
    const state = feedState(checkpoint)
    if (state === null) {
      const token = await startPageToken(tm)
      return new Delta({
        changes: [],
        checkpoint: feedCheckpoint({ token, seen: {} }),
      })
    }
    const [found, token] = await listChanges(tm, state.token)
    const prefix = rstripSlash(mountPrefixOf(root.virtual, root.vfsPath))
    const seen: Record<string, string> = { ...(state.seen ?? {}) }
    const changes: [FileChangeKind, string][] = []
    for (const change of found) {
      const itemId = change.fileId
      if (typeof itemId !== 'string') continue
      const item = change.file
      if (item?.mimeType !== this.mime) {
        if (change.removed === true) settle(changes, seen, itemId, null, false)
        continue
      }
      const path = this.path(prefix, item)
      if (change.removed === true || item.trashed === true) {
        if (!Object.hasOwn(seen, itemId)) seen[itemId] = path
        settle(changes, seen, itemId, null, false)
        continue
      }
      settle(changes, seen, itemId, path, justMade(item.createdTime, item.modifiedTime))
    }
    return new Delta({
      changes: changesUnder(root, changes, observed),
      checkpoint: feedCheckpoint({ token, seen }),
    })
  }

  /** Where the app lists `item`. */
  private path(prefix: string, item: DriveFile): string {
    const corpus = item.owners?.[0]?.me === true ? 'owned' : 'shared'
    const name = this.makeFilename(item.name, item.id, item.modifiedTime ?? '')
    return `${prefix}/${corpus}/${name}`
  }
}

/** The delta hook of a Google app mount (`AppDeltaHook`). Mirrors Python's `app_delta_hook`. */
export function appDeltaHook(
  accessor: GoogleApiAccessor,
  mime: string,
  makeFilename: (title: string, id: string, modified?: string) => string,
): DeltaHook {
  return new AppDeltaHook(accessor, mime, makeFilename)
}
