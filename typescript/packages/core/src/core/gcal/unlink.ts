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
import type { IndexEntry } from '../../cache/index/config.ts'
import { eacces, enoent } from '../../utils/errors.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeUnlink } from '../hierarchy/unlink.ts'
import { deleteEvent } from './client.ts'
import { calendarIndex, readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

const WRITABLE_ROLES = new Set(['owner', 'writer'])

/**
 * Delete the event the entry names, on the slotted calendar.
 *
 * The entry already carries the event id (rm resolves through the name the
 * listing produced), so only the calendar's id and write role are looked up
 * here.
 */
async function del(accessor: GCalAccessor, match: ScopeMatch, entry: IndexEntry): Promise<void> {
  const calendars = await calendarIndex(accessor)
  const calendar = calendars.get(match.slots.calendar ?? '')
  if (calendar === undefined) throw enoent(match.vfsPath)
  const role = calendar.accessRole
  if (typeof role !== 'string' || !WRITABLE_ROLES.has(role)) throw eacces(match.vfsPath)
  const calId = calendar.id
  if (typeof calId !== 'string') throw enoent(match.vfsPath)
  await deleteEvent(accessor.tokenManager, calId, entry.id)
}

export const unlink = makeUnlink(detectScope, readdir, { deleters: { event: del } })
