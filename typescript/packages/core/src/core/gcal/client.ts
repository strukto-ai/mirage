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

import type { JsonValue } from '../../types.ts'
import { calendarBase, googleDelete, googleGet, type TokenManager } from '../google/_client.ts'

const MAX_PAGES = 50

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
    items.push(...rows(data))
    token = nextToken(data)
    if (token === null) break
  }
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
  timeMin: string,
  timeMax: string,
  timeZone?: string,
): Promise<Record<string, JsonValue>[]> {
  // The id is one path segment and several real ones are not URL-safe: a
  // holiday calendar is "en.usa#holiday@group.v.calendar.google.com", and an
  // unencoded "#" opens a fragment, so the request would reach
  // /calendars/en.usa instead.
  const url = `${calendarBase(tokenManager)}/calendars/${encodeURIComponent(calendarId)}/events`
  const base: Record<string, string> = {
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  }
  if (timeZone !== undefined && timeZone !== '') base.timeZone = timeZone
  const items: Record<string, JsonValue>[] = []
  let token: string | null = null
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = token !== null ? { ...base, pageToken: token } : base
    const data = await googleGet(tokenManager, url, page)
    items.push(...rows(data))
    token = nextToken(data)
    if (token === null) break
  }
  return items
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
