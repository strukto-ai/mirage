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

import { enoent } from '../../utils/errors.ts'
import { makeIdName } from '../../utils/naming.ts'
import {
  NAME_MAX_BYTES,
  sanitizeName,
  stripTrailingUnderscores,
  truncateBytes,
} from '../../utils/sanitize.ts'

const EVENT_SUFFIX = '.gcal.json'
export const CALENDAR_FILE = 'calendar.json'
export const PRIMARY_DIR = 'primary'
// "HHMM-HHMM"
const HHMM_LEN = 9
const UNTITLED = 'untitled'
// A freeBusyReader calendar returns availability with no summary at all, so
// there is no title to sanitize and "busy" is the honest rendering.
const BUSY = 'busy'

const UTF8 = new TextEncoder()

/** Pick the title segment for an event filename. */
export function eventTitle(summary: string | null, freeBusy = false): string {
  if (summary !== null && summary.trim() !== '') return sanitizeName(summary)
  return freeBusy ? BUSY : UNTITLED
}

/**
 * Build an event filename: id first, then the day-local times, then title.
 *
 * The id leads so that trimming the title can never make two events collide
 * and so `ls <idprefix>*` addresses one event. Google event ids are 5-1024
 * characters by spec (26 in practice), so the title takes whatever of the
 * 255-byte NAME_MAX is left rather than a fixed character count.
 */
export function makeEventFilename(eventId: string, hhmm: string, title: string): string {
  const fixed = UTF8.encode(eventId).length + 2 + hhmm.length + 1 + EVENT_SUFFIX.length
  const trimmed = stripTrailingUnderscores(truncateBytes(title, NAME_MAX_BYTES - fixed))
  if (trimmed === '') {
    // The title is what gives, never the id: trimming the id would make the
    // name stop addressing the event, which is the whole reason it leads. An
    // id long enough that even this form overflows NAME_MAX is therefore
    // unnameable rather than silently mangled. The spec permits one (ids run
    // 5-1024 chars) but only a caller-supplied id from events.import can be
    // that long; Google's own are 26.
    return `${eventId}__${hhmm}${EVENT_SUFFIX}`
  }
  return `${eventId}__${hhmm}_${trimmed}${EVENT_SUFFIX}`
}

/**
 * Recover `[eventId, hhmm]` from an event filename.
 *
 * Splitting on the first `__` is safe because a Google event id is base32hex
 * and can hold neither an underscore nor a separator, while a title
 * routinely holds both.
 */
export function parseEventFilename(name: string): [string, string] {
  if (!name.endsWith(EVENT_SUFFIX)) throw enoent(name)
  const raw = name.slice(0, -EVENT_SUFFIX.length)
  const idx = raw.indexOf('__')
  if (idx <= 0) throw enoent(name)
  const rest = raw.slice(idx + 2)
  if (rest.length < HHMM_LEN) throw enoent(name)
  return [raw.slice(0, idx), rest.slice(0, HHMM_LEN)]
}

/**
 * Build the directory name for one calendar.
 *
 * The primary calendar is spelled `primary` because that is the stable alias
 * every Calendar API call accepts, and its summary is only the account's own
 * email address.
 */
export function makeCalendarDirname(summary: string, calendarId: string, primary = false): string {
  if (primary) return PRIMARY_DIR
  return makeIdName(summary, calendarId)
}

/** Recover the calendar id a directory name addresses. */
export function parseCalendarDirname(name: string): string {
  if (name === PRIMARY_DIR) return PRIMARY_DIR
  // lastIndexOf, not indexOf: a calendar id holds "@" and "." but the
  // sanitized title before it may itself contain "__".
  const idx = name.lastIndexOf('__')
  if (idx === -1) throw enoent(name)
  const calendarId = name.slice(idx + 2)
  if (calendarId === '') throw enoent(name)
  return calendarId
}
