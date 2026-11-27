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

import { GCalAccessor } from '../../src/accessor/gcal.ts'
import { TokenManager } from '../../src/core/google/client.ts'
import { PathSpec } from '../../src/types.ts'
import type { Clock } from '../../src/utils/clock.ts'
import { GCalConfig } from '../../src/vfs/gcal/config.ts'
import { parseConfigWithSchema } from '../../src/vfs/secrets.ts'
import { GoogleAccount } from './google_account.ts'
import type { JsonValue } from './kit_fake.ts'

export const HK = 'Asia/Hong_Kong'
export const TODAY = '2026-08-11'
export const TEAM = 'team@group.calendar.google.com'
export const SHARED = 'busy@group.calendar.google.com'

/**
 * Each event of the primary calendar: its id, title, start and end. A
 * `YYYY-MM-DD` pair is an all-day event.
 */
export const EVENT_ROWS: readonly [string, string, string, string][] = [
  ['aaaa1', 'PhD Defense', '2026-08-11T09:00:00+08:00', '2026-08-11T10:30:00+08:00'],
  ['bbbb2', 'Committee Meeting', '2026-08-11T15:00:00+08:00', '2026-08-11T16:00:00+08:00'],
  ['cccc3', 'Conference', '2026-08-10T09:00:00+08:00', '2026-08-13T17:00:00+08:00'],
  ['dddd4', 'Public Holiday', '2026-08-11', '2026-08-12'],
  ['eeee5', 'Last Year', '2025-01-05T09:00:00+08:00', '2025-01-05T10:00:00+08:00'],
]

/** `EVENT_ROWS` as a shared calendar holds them, each id led by `prefix`: an event id is unique in the account. */
function copies(prefix: string): JsonValue[] {
  return EVENT_ROWS.map(([id, summary, start, end]) => {
    const key = start.length === 10 ? 'date' : 'dateTime'
    return { id: prefix + id, summary, start: { [key]: start }, end: { [key]: end } }
  })
}

/**
 * Give the account the calendars the gcal tests read: its own primary, in
 * Hong Kong, holding `EVENT_ROWS`; Engineering, a Los Angeles calendar shared
 * with it to read; and Exec, shared with it free/busy only. Both shared
 * calendars hold the same events under ids of their own, `t` and `s` before
 * each.
 */
export async function seed(account: GoogleAccount): Promise<void> {
  await account.calendars(
    {
      id: TEAM,
      summary: 'Engineering',
      timeZone: 'America/Los_Angeles',
      accessRole: 'reader',
      events: copies('t'),
    },
    {
      id: SHARED,
      summary: 'Exec',
      timeZone: HK,
      accessRole: 'freeBusyReader',
      events: copies('s'),
    },
  )
  for (const [eventId, summary, start, end] of EVENT_ROWS) {
    await account.event(summary, start, end, { eventId })
  }
}

/**
 * An account of its own on the fake at `origin`, holding the calendars
 * `seed` gives it, its requests recorded from here.
 */
export async function calendarAccount(origin: string): Promise<GoogleAccount> {
  const account = new GoogleAccount(origin)
  await seed(account)
  await account.run.recordRequests()
  return account
}

/** A mount config signed in to `account`, today pinned to `TODAY`. */
export function gcalConfig(
  account: GoogleAccount,
  overrides: Record<string, JsonValue> = {},
): GCalConfig {
  return parseConfigWithSchema(GCalConfig, account.fields({ today: TODAY, ...overrides }))
}

/**
 * An accessor for `gcalConfig(account, overrides)`, walking under a cap
 * unless `capped` says not, its retries waiting on `clock`.
 */
export function makeAccessor(
  account: GoogleAccount,
  overrides: Record<string, JsonValue> = {},
  capped = (): boolean => true,
  clock?: Clock,
): GCalAccessor {
  const config = gcalConfig(account, overrides)
  return new GCalAccessor({ tokenManager: new TokenManager(config, clock), config, capped })
}

/**
 * Each events listing asked since recording started, as
 * `[calendar, timeMin, timeMax]`, null for a bound it leaves open.
 */
export async function eventListings(account: GoogleAccount): Promise<(string | null)[][]> {
  return (await account.calendarLog()).filter((e) => e[0] === 'list').map((e) => e.slice(1))
}

/** A mount-relative PathSpec, globbed when a pattern is given. */
export function spec(virtual: string, pattern?: string): PathSpec {
  const directory =
    pattern !== undefined ? virtual.slice(0, virtual.lastIndexOf('/')) || '/' : virtual
  return new PathSpec({
    virtual,
    directory,
    vfsPath: virtual.replace(/^\//, ''),
    ...(pattern !== undefined ? { pattern } : {}),
  })
}

/** The last segment of each listed path. */
export function names(paths: readonly string[]): string[] {
  return paths.map((p) => p.slice(p.lastIndexOf('/') + 1))
}
