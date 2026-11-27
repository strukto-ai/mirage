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

import type { JsonValue, KitRoute, Reply } from '../../kit/typescript/index.ts'
import { route } from '../wire/route.ts'
import type { Ctx } from '../../kit/typescript/index.ts'
import type { C } from '../store/client.ts'
import type { GwsState } from '../store/state.ts'
import type { CalendarEntry, CalendarEvent } from '../store/types.ts'
import { asObj, asObjArr, asStr } from '../wire/json.ts'
import { NOT_FOUND, googleError, isReply, noContent, ok } from '../wire/reply.ts'
import {
  calendarOr404,
  eventIdTaken,
  eventsOf,
  fmtEvent,
  isEventId,
  listCalendarEvents,
  makeEvent,
  readEventTimes,
} from './event.ts'
import { eventEndMs, eventStartMs, isIanaZone } from './zone.ts'

type GwsCtx = Ctx<GwsState>

const NEED_WRITER = 'You need to have writer access.'
// Calendar's access roles, the least first.
const ROLES = ['freeBusyReader', 'reader', 'writer', 'owner']

function writable(cal: CalendarEntry): boolean {
  return cal.accessRole === 'owner' || cal.accessRole === 'writer'
}

function createEvent(ctx: GwsCtx): Reply {
  const cal = calendarOr404(ctx.db, ctx.params.calendarId ?? '')
  if (cal === null) return NOT_FOUND
  if (!writable(cal)) return googleError(403, NEED_WRITER, 'PERMISSION_DENIED')
  const body = asObj(ctx.json())
  // A caller may name the event: base32hex (0-9 and a-v), 5 to 1024
  // characters, as Calendar takes one. Calendar asks it to be unique in the
  // calendar; here every calendar's events share one table, so it is unique
  // in the account.
  const pinned = asStr(body.id)
  if (pinned !== undefined && !isEventId(pinned)) {
    return googleError(400, 'Invalid resource id value.', 'INVALID_ARGUMENT')
  }
  if (pinned !== undefined && eventIdTaken(ctx.db, pinned)) {
    return googleError(409, 'The requested identifier already exists.', 'ALREADY_EXISTS')
  }
  const times = readEventTimes(body, cal.timeZone)
  if (isReply(times)) return times
  const ev = makeEvent(ctx.db, body, times, pinned)
  eventsOf(ctx.db, cal.id).set(ev.id, ev)
  ctx.db.noteCalendarChange(cal.id, ev.id)
  return ok(fmtEvent(cal, ev))
}

function withEvent(
  ctx: GwsCtx,
): { cal: CalendarEntry; ev: CalendarEvent; bucket: Map<string, CalendarEvent> } | Reply {
  const cal = calendarOr404(ctx.db, ctx.params.calendarId ?? '')
  if (cal === null) return NOT_FOUND
  const bucket = eventsOf(ctx.db, cal.id)
  const ev = bucket.get(ctx.params.eventId ?? '')
  if (ev === undefined) return googleError(404, 'Not Found', 'NOT_FOUND')
  return { cal, ev, bucket }
}

function patchEvent(ctx: GwsCtx, replace = false): Reply {
  const found = withEvent(ctx)
  if (isReply(found)) return found
  if (!writable(found.cal)) return googleError(403, NEED_WRITER, 'PERMISSION_DENIED')
  const body = asObj(ctx.json())
  const times = readEventTimes(body, found.cal.timeZone, replace ? undefined : found.ev)
  if (isReply(times)) return times
  const status = body.status === undefined ? (replace ? 'confirmed' : found.ev.status) : body.status
  if (status !== 'confirmed' && status !== 'tentative' && status !== 'cancelled') {
    return googleError(400, 'Invalid event status.', 'INVALID_ARGUMENT')
  }
  const next: CalendarEvent = {
    ...(replace ? { id: found.ev.id, created: found.ev.created } : found.ev),
    status,
    start: times.start,
    end: times.end,
    updated: ctx.db.now(),
  }
  const summary = asStr(body.summary)
  const description = asStr(body.description)
  const location = asStr(body.location)
  if (summary !== undefined) next.summary = summary
  if (description !== undefined) next.description = description
  if (location !== undefined) next.location = location
  if (body.attendees !== undefined) next.attendees = body.attendees
  found.bucket.set(found.ev.id, next)
  ctx.db.noteCalendarChange(found.cal.id, found.ev.id)
  return ok(fmtEvent(found.cal, next))
}

// calendars.patch: the owner changes a calendar's title or zone. The zone is
// what each of its events renders in, and so the day an event falls on. A
// calendar shared with the account is not its to change; the refusal is the
// generic one, not a probed wording, as is the one for a zone Intl cannot
// resolve.
function patchCalendar(ctx: GwsCtx): Reply {
  const cal = calendarOr404(ctx.db, ctx.params.calendarId ?? '')
  if (cal === null) return NOT_FOUND
  if (cal.accessRole !== 'owner') return googleError(403, 'Forbidden', 'PERMISSION_DENIED')
  const body = asObj(ctx.json())
  const summary = asStr(body.summary)
  const timeZone = asStr(body.timeZone)
  if (timeZone !== undefined && !isIanaZone(timeZone)) {
    return googleError(400, 'Bad Request', 'INVALID_ARGUMENT')
  }
  if (summary !== undefined) cal.summary = summary
  if (timeZone !== undefined) cal.timeZone = timeZone
  return ok(calendarResource(cal))
}

function calendarResource(cal: CalendarEntry): JsonValue {
  return { kind: 'calendar#calendar', id: cal.id, summary: cal.summary, timeZone: cal.timeZone }
}

function freeBusy(ctx: GwsCtx): Reply {
  const body = asObj(ctx.json())
  const timeMin = String(body.timeMin ?? '')
  const timeMax = String(body.timeMax ?? '')
  const lo = Date.parse(timeMin)
  const hi = Date.parse(timeMax)
  const calendars: Record<string, JsonValue> = {}
  for (const item of asObjArr(body.items)) {
    const wanted = String(item.id ?? '')
    const cal = calendarOr404(ctx.db, wanted)
    if (cal === null) {
      calendars[wanted] = { errors: [{ domain: 'global', reason: 'notFound' }] }
      continue
    }
    const busy = [...eventsOf(ctx.db, cal.id).values()]
      .filter((ev) => ev.status !== 'cancelled')
      .filter((ev) => eventEndMs(ev, cal.timeZone) > lo && eventStartMs(ev, cal.timeZone) < hi)
      .sort((a, b) => eventStartMs(a, cal.timeZone) - eventStartMs(b, cal.timeZone))
      .map((ev): JsonValue => ({
        start: new Date(eventStartMs(ev, cal.timeZone)).toISOString(),
        end: new Date(eventEndMs(ev, cal.timeZone)).toISOString(),
      }))
    calendars[wanted] = { busy }
  }
  return ok({ kind: 'calendar#freeBusy', timeMin, timeMax, calendars })
}

export function calendarRoutes(): KitRoute<C>[] {
  return [
    route('GET', '/calendar/v3/users/me/calendarList', (ctx) => {
      const showHidden = ctx.query.get('showHidden') === 'true'
      // minAccessRole keeps the calendars the account holds at least that
      // role on.
      const least = ROLES.indexOf(ctx.query.get('minAccessRole') ?? 'freeBusyReader')
      const items = [...ctx.db.calendars.values()]
        .filter((c) => showHidden || c.hidden !== true)
        .filter((c) => ROLES.indexOf(c.accessRole) >= least)
      return ok({
        kind: 'calendar#calendarList',
        items: items.map((c): JsonValue => ({
          kind: 'calendar#calendarListEntry',
          id: c.id,
          summary: c.summary,
          timeZone: c.timeZone,
          accessRole: c.accessRole,
          ...(c.primary === true ? { primary: true } : {}),
        })),
      })
    }),
    route('POST', '/calendar/v3/freeBusy', freeBusy),
    route('GET', '/calendar/v3/calendars/:calendarId/events', (ctx) => {
      const cal = calendarOr404(ctx.db, ctx.params.calendarId ?? '')
      if (cal === null) return NOT_FOUND
      return listCalendarEvents(ctx.db, cal, ctx.query)
    }),
    route('POST', '/calendar/v3/calendars/:calendarId/events', createEvent, { write: true }),
    route('GET', '/calendar/v3/calendars/:calendarId/events/:eventId', (ctx) => {
      const found = withEvent(ctx)
      if (isReply(found)) return found
      return ok(fmtEvent(found.cal, found.ev))
    }),
    route(
      'PUT',
      '/calendar/v3/calendars/:calendarId/events/:eventId',
      (ctx) => patchEvent(ctx, true),
      { write: true },
    ),
    route('PATCH', '/calendar/v3/calendars/:calendarId/events/:eventId', patchEvent, {
      write: true,
    }),
    route(
      'DELETE',
      '/calendar/v3/calendars/:calendarId/events/:eventId',
      (ctx) => {
        const found = withEvent(ctx)
        if (isReply(found)) return found
        if (!writable(found.cal)) return googleError(403, NEED_WRITER, 'PERMISSION_DENIED')
        found.bucket.delete(found.ev.id)
        ctx.db.noteCalendarChange(found.cal.id, found.ev.id)
        return noContent()
      },
      { write: true },
    ),
    route('GET', '/calendar/v3/calendars/:calendarId', (ctx) => {
      const cal = calendarOr404(ctx.db, ctx.params.calendarId ?? '')
      if (cal === null) return NOT_FOUND
      return ok(calendarResource(cal))
    }),
    route('PATCH', '/calendar/v3/calendars/:calendarId', patchCalendar, { write: true }),
  ]
}
