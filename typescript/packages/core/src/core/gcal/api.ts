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
import type { TokenManager } from '../google/client.ts'
import { TimeRange } from '../time_range.ts'
import * as client from './client.ts'

/**
 * Every Calendar request the gcal backend makes, as one object. A core op
 * reaches Calendar only through `accessor.calendar`. Mirrors Python's
 * `CalendarApi`.
 */
export interface CalendarApi {
  listCalendars(minAccessRole?: string): Promise<Record<string, JsonValue>[]>
  listEvents(
    calendarId: string,
    timeMin: string | null,
    timeMax: string,
    timeZone?: string,
    scope?: TimeRange,
    query?: string,
  ): Promise<Record<string, JsonValue>[]>
  syncEvents(
    calendarId: string,
    syncToken: string | null,
    timeZone?: string,
  ): Promise<[Record<string, JsonValue>[], string | null]>
  deleteEvent(calendarId: string, eventId: string): Promise<void>
}

/** The live `CalendarApi`: one token manager, one wire call per method. */
export class CalendarClient implements CalendarApi {
  readonly tokenManager: TokenManager

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager
  }

  listCalendars(minAccessRole?: string): Promise<Record<string, JsonValue>[]> {
    return client.listCalendars(this.tokenManager, minAccessRole)
  }

  listEvents(
    calendarId: string,
    timeMin: string | null,
    timeMax: string,
    timeZone?: string,
    scope: TimeRange = new TimeRange(),
    query?: string,
  ): Promise<Record<string, JsonValue>[]> {
    return client.listEvents(
      this.tokenManager,
      calendarId,
      timeMin,
      timeMax,
      timeZone,
      scope,
      query,
    )
  }

  syncEvents(
    calendarId: string,
    syncToken: string | null,
    timeZone?: string,
  ): Promise<[Record<string, JsonValue>[], string | null]> {
    return client.syncEvents(this.tokenManager, calendarId, syncToken, timeZone)
  }

  deleteEvent(calendarId: string, eventId: string): Promise<void> {
    return client.deleteEvent(this.tokenManager, calendarId, eventId)
  }
}
