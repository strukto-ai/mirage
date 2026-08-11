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

import type { GCalAccessor } from '../../accessor/gcal.ts'
import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { parseEventFilename } from '../../resource/gcal/event_entry.ts'
import type { PathSpec } from '../../types.ts'
import { eacces, eisdir, enoent } from '../../utils/errors.ts'
import { deleteEvent } from './client.ts'
import { calendarIndex, normalize } from './readdir.ts'

const WRITABLE_ROLES = new Set(['owner', 'writer'])

/**
 * Delete the event a path names.
 *
 * The path carries the event id, so no read is needed first: rm resolves
 * through the name the listing already produced.
 */
export async function unlink(
  accessor: GCalAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  const [, key, virtualKey] = normalize(path)
  const parts = key === '' ? [] : key.split('/')
  if (parts.length !== 3) throw eisdir(path.virtual)
  const calendars = await calendarIndex(accessor)
  const entry = calendars.get(parts[0] as string)
  if (entry === undefined) throw enoent(path.virtual)
  const role = entry.accessRole
  if (typeof role !== 'string' || !WRITABLE_ROLES.has(role)) throw eacces(path.virtual)
  const calId = entry.id
  if (typeof calId !== 'string') throw enoent(path.virtual)
  const [eventId] = parseEventFilename(parts[2] as string)
  await deleteEvent(accessor.tokenManager, calId, eventId)
  const parentDir = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
  if (index !== undefined) await index.invalidateDir(parentDir)
  await invalidateAfterUnlink(virtualKey)
}
