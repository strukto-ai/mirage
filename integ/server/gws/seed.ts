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

import { ResetBodyError } from '../kit/typescript/index.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import { createDriveItem } from './drive/item.ts'
import { eventsOf, makeEvent } from './calendar/event.ts'
import { DEFAULT_CALENDAR_TZ } from './store/state.ts'
import type { GwsState } from './store/state.ts'
import type { FormDoc } from './store/types.ts'
import { newFormItem } from './forms/form.ts'
import { asBool, asObjArr, asStr, isObj } from './wire/json.ts'
import type { JsonObj } from './wire/json.ts'
import { FORM_MIME } from './wire/mime.ts'

// A secondary calendar and a form carrying responses are both harness state
// rather than anything the API can mint: you own every calendar you create,
// so a reader one is by definition shared with you, and the Forms API has no
// method that submits a response at all. Both therefore ride /reset, as
// `extras`, the same out-of-band channel the kit already offers a fake whose
// seed needs something a fixture row cannot say.
//
// The BASE world -- the four system labels and the primary calendar -- is not
// here any more: it is ordinary fixture rows, at integ/fixtures/gws/v1.json,
// which is what a kit fake states declaratively. Only the two states the API
// cannot produce are left.
export function seedCalendars(st: GwsState, entries: JsonObj[]): void {
  for (const entry of entries) {
    const id = asStr(entry.id) ?? ''
    st.calendars.set(id, {
      id,
      summary: asStr(entry.summary) ?? '',
      timeZone: asStr(entry.timeZone) ?? DEFAULT_CALENDAR_TZ,
      accessRole: asStr(entry.accessRole) ?? 'owner',
      ...(asBool(entry.hidden) === true ? { hidden: true } : {}),
    })
    const bucket = eventsOf(st, id)
    for (const raw of asObjArr(entry.events)) {
      const ev = makeEvent(st, raw)
      if (ev === null) {
        throw new Error(`seed event needs a start and an end: ${JSON.stringify(raw)}`)
      }
      bucket.set(ev.id, ev)
    }
  }
}

export function seedForms(st: GwsState, entries: JsonObj[]): void {
  for (const entry of entries) {
    const title = asStr(entry.title) ?? ''
    const documentTitle = asStr(entry.documentTitle) ?? title
    const description = asStr(entry.description)
    // Through the Drive table for the same reason forms.create is: the
    // formId IS the Drive file id, and a seeded form has to be findable
    // the one way an agent can find one.
    const item = createDriveItem(
      st,
      documentTitle,
      FORM_MIME,
      [],
      Buffer.alloc(0),
      st.nextId('form'),
    )
    const form: FormDoc = {
      formId: item.id,
      title,
      documentTitle,
      ...(description === undefined ? {} : { description }),
      items: asObjArr(entry.items).map((raw) => newFormItem(st, raw)),
      responses: asObjArr(entry.responses),
      revision: 1,
    }
    st.forms.set(item.id, form)
  }
}

// Present but not a list is refused rather than skipped. The fake this replaces
// threw a TypeError on `{"calendars": null}` and answered 500; seeding nothing
// and answering `{"ok":true}` would turn that loud failure into a silent one,
// and a harness whose seed quietly did nothing is the worst way to find out.
// A ResetBodyError is what the kit's own reset path answers 400 for, so the
// caller is told which field it got wrong rather than that the fake crashed.
function listField(name: string, value: JsonValue | undefined): JsonObj[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ResetBodyError(`/reset extras.${name} must be a list`)
  return value.filter(isObj)
}

const KNOWN = new Set(['calendarTimeZone', 'calendars', 'forms'])

export function applyExtras(st: GwsState, extras: Record<string, JsonValue>): void {
  const unknown = Object.keys(extras).filter((k) => !KNOWN.has(k))
  if (unknown.length > 0) {
    throw new ResetBodyError(`unknown /reset extras: ${unknown.sort().join(', ')}`)
  }
  const tz = extras.calendarTimeZone
  if (tz !== undefined) {
    if (typeof tz !== 'string') {
      throw new ResetBodyError('/reset extras.calendarTimeZone must be a string')
    }
    // The primary calendar is a fixture row, so its zone is the fixture's
    // default until a reset says otherwise; retuning it here rather than
    // shipping a second fixture keeps one file per scenario.
    for (const cal of st.calendars.values()) if (cal.primary === true) cal.timeZone = tz
  }
  seedCalendars(st, listField('calendars', extras.calendars))
  seedForms(st, listField('forms', extras.forms))
}
