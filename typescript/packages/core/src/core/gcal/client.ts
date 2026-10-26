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

import { TimeRange, parseTime } from '../time_range.ts'
import { eventSpan } from './day.ts'
import type { JsonValue } from '../../types.ts'
import { calendarBase, googleDelete, googleGet, type TokenManager } from '../google/client.ts'

const MAX_PAGES = 50

export const PAGE_LIMIT = 'gcal: listing exceeded 50 pages; narrow the date range'

function rows(data: unknown): Record<string, JsonValue>[] {
  if (typeof data !== 'object' || data === null) return []
  const items = (data as Record<string, unknown>).items
  if (!Array.isArray(items)) return []
  return items.filter(
    (r): r is Record<string, JsonValue> => typeof r === 'object' && r !== null && !Array.isArray(r),
  )
}

function nextToken(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const next = (data as Record<string, unknown>).nextPageToken
  return typeof next === 'string' && next !== '' ? next : null
}

/**
 * List the account's calendars.
 *
 * showHidden is left at its default (false) so the mount shows what the
 * Calendar UI shows; a subscribed holiday calendar the user hid stays out.
 */
export async function listCalendars(
  tokenManager: TokenManager,
  minAccessRole?: string,
): Promise<Record<string, JsonValue>[]> {
  const url = `${calendarBase(tokenManager)}/users/me/calendarList`
  const base: Record<string, string> = {}
  if (minAccessRole !== undefined && minAccessRole !== '') base.minAccessRole = minAccessRole
  const items: Record<string, JsonValue>[] = []
  let token: string | null = null
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = token !== null ? { ...base, pageToken: token } : base
    const data = await googleGet(tokenManager, url, page)
    for (const item of rows(data)) items.push(item)
    token = nextToken(data)
    if (token === null) break
  }
  if (token !== null) throw new Error(PAGE_LIMIT)
  return items
}

/**
 * List a calendar's events overlapping a time window.
 *
 * timeMin bounds an event's END and timeMax its START, both exclusive, so
 * the pair is an overlap query: a multi-day or midnight-crossing event is
 * returned by every day window it touches, with no extra request.
 *
 * singleEvents expands a recurring series into its instances, which is what
 * makes a day directory well defined; without it the series' own record
 * would stand in for every occurrence.
 */
export async function listEvents(
  tokenManager: TokenManager,
  calendarId: string,
  timeMin: string | null,
  timeMax: string,
  timeZone?: string,
  scope: TimeRange = new TimeRange(),
  query?: string,
): Promise<Record<string, JsonValue>[]> {
  // The id is one path segment and several real ones are not URL-safe: a
  // holiday calendar is "en.usa#holiday@group.v.calendar.google.com", and an
  // unencoded "#" opens a fragment, so the request would reach
  // /calendars/en.usa instead.
  const url = `${calendarBase(tokenManager)}/calendars/${encodeURIComponent(calendarId)}/events`
  const [lo, hi] = scope.clip(timeMin === null ? -Infinity : parseTime(timeMin), parseTime(timeMax))
  if (lo >= hi) return []
  const base: Record<string, string> = {
    timeMax: new Date(Math.ceil(hi) * 1000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  }
  if (Number.isFinite(lo)) base.timeMin = new Date(Math.floor(lo) * 1000).toISOString()
  if (timeZone !== undefined && timeZone !== '') base.timeZone = timeZone
  if (query !== undefined) base.q = query
  const items: Record<string, JsonValue>[] = []
  let token: string | null = null
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = token !== null ? { ...base, pageToken: token } : base
    const data = await googleGet(tokenManager, url, page)
    for (const item of rows(data)) items.push(item)
    token = nextToken(data)
    if (token === null) break
  }
  if (token !== null) throw new Error(PAGE_LIMIT)
  return scope.bounded
    ? items.filter((event) => {
        const span = eventSpan(event, timeZone ?? 'UTC')
        return span !== null && listed(span, lo, hi)
      })
    : items
}

/**
 * Whether a listing of the window `lo`..`hi` (epoch seconds) keeps an event
 * spanning `span` (epoch ms): one that starts before the window ends and ends
 * after it starts, or an instant one at or after its start. Mirrors Python's
 * `listed`.
 */
export function listed(span: readonly [number, number], lo: number, hi: number): boolean {
  const [start, end] = [span[0] / 1000, span[1] / 1000]
  return start < hi && (end > lo || (start === end && start >= lo))
}

/**
 * A calendar's events changed since `syncToken`, every event when null, and
 * the token the next sync starts from. Instances of a recurring series come one
 * by one (singleEvents), as a listing names them, and one deleted since the
 * token comes back with status `cancelled`. Calendar answers 410 for a token it
 * no longer honors, which rejects as any failed call does. Mirrors Python's
 * `sync_events`.
 */
export async function syncEvents(
  tokenManager: TokenManager,
  calendarId: string,
  syncToken: string | null,
  timeZone?: string,
): Promise<[Record<string, JsonValue>[], string | null]> {
  const url = `${calendarBase(tokenManager)}/calendars/${encodeURIComponent(calendarId)}/events`
  const base: Record<string, string> = { singleEvents: 'true', maxResults: '2500' }
  if (timeZone !== undefined && timeZone !== '') base.timeZone = timeZone
  if (syncToken !== null) base.syncToken = syncToken
  const items: Record<string, JsonValue>[] = []
  let token: string | null = null
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = token !== null ? { ...base, pageToken: token } : base
    const data = await googleGet(tokenManager, url, page)
    for (const item of rows(data)) items.push(item)
    token = nextToken(data)
    if (token === null) {
      const done = (data as Record<string, unknown>).nextSyncToken
      return [items, typeof done === 'string' ? done : null]
    }
  }
  throw new Error(PAGE_LIMIT)
}

/** Delete one event. */
export async function deleteEvent(
  tokenManager: TokenManager,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const url =
    `${calendarBase(tokenManager)}/calendars/${encodeURIComponent(calendarId)}` +
    `/events/${encodeURIComponent(eventId)}`
  await googleDelete(tokenManager, url)
}
