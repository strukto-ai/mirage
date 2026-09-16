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
import { eventsOf, makeEvent, readEventTimes } from './calendar/event.ts'
import { DEFAULT_CALENDAR_TZ } from './store/state.ts'
import { isIanaZone } from './calendar/zone.ts'
import type { GwsState } from './store/state.ts'
import type { DocTab, FormDoc } from './store/types.ts'
import { newFormItem } from './forms/form.ts'
import { asBool, asObjArr, asStr, isObj } from './wire/json.ts'
import type { JsonObj } from './wire/json.ts'
import { DOC_MIME, FORM_MIME } from './wire/mime.ts'
import { isReply } from './wire/reply.ts'

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
    const timeZone = asStr(entry.timeZone) ?? DEFAULT_CALENDAR_TZ
    // Every timed event now renders in the calendar's zone, so an
    // unresolvable one would throw a RangeError out of Intl on read
    // rather than here. The fake fails at the door instead.
    if (!isIanaZone(timeZone)) {
      throw new ResetBodyError(
        `seed calendar ${entry.id ?? ''} timeZone is not a zone: ${timeZone}`,
      )
    }
    st.calendars.set(id, {
      id,
      summary: asStr(entry.summary) ?? '',
      timeZone,
      accessRole: asStr(entry.accessRole) ?? 'owner',
      ...(asBool(entry.hidden) === true ? { hidden: true } : {}),
    })
    const bucket = eventsOf(st, id)
    for (const raw of asObjArr(entry.events)) {
      const times = readEventTimes(raw, timeZone)
      if (isReply(times)) {
        throw new Error(`seed event ${JSON.stringify(raw)} refused: ${JSON.stringify(times.body)}`)
      }
      const ev = makeEvent(st, raw, times)
      bucket.set(ev.id, ev)
    }
  }
}

// Every id a fixture pinned, collected before any is minted so a mint can
// step over one, whichever order the two appear in. A pin repeated is a
// fixture bug and is named here: DocTab is keyed by (tenant, documentId,
// tabId), so the alternative is a primary-key violation at save time,
// reported against a table rather than against the line that caused it.
function pinnedTabIds(entries: JsonObj[], seen: Set<string>): Set<string> {
  for (const raw of entries) {
    const pinned = asStr(raw.tabId)
    if (pinned !== undefined) {
      if (seen.has(pinned)) {
        throw new ResetBodyError(`/reset extras.docs pins tab id "${pinned}" twice`)
      }
      seen.add(pinned)
    }
    pinnedTabIds(asObjArr(raw.childTabs), seen)
  }
  return seen
}

// Tab ids are minted in pre-order (t.0, t.1, ... across the whole
// document, children before the next sibling) so a truth file can name one
// and stay stable. A fixture may pin its own instead, and a minted id then
// steps over every pinned one rather than colliding with it.
function docTabsFrom(entries: JsonObj[], mint: () => string): DocTab[] {
  return entries.map((raw) => {
    const tabId = asStr(raw.tabId) ?? mint()
    return {
      tabId,
      title: asStr(raw.title) ?? '',
      text: asStr(raw.text) ?? '',
      childTabs: docTabsFrom(asObjArr(raw.childTabs), mint),
    }
  })
}

// A MULTI-TAB document is a state the Docs API cannot produce: there is no
// request that creates a tab, so unlike the single-tab docs in the `apps`
// fixture -- which seed through documents.create plus a batchUpdate -- one
// of these cannot be built by driving the same API a backend speaks. It
// therefore rides `extras`, for the same reason a secondary calendar and a
// submitted form response do.
export function seedDocs(st: GwsState, entries: JsonObj[]): void {
  for (const entry of entries) {
    const name = asStr(entry.name) ?? ''
    // Through the Drive table because the documentId IS the Drive file id,
    // which is what makes a seeded doc findable the one way an agent can
    // find one.
    const item = createDriveItem(st, name, DOC_MIME, [], Buffer.alloc(0), st.nextId('doc'))
    const doc = st.docs.get(item.id)
    if (doc === undefined) throw new ResetBodyError(`doc ${item.id} was not auto-linked`)
    const declared = asObjArr(entry.tabs)
    const pinned = pinnedTabIds(declared, new Set<string>())
    let next = 0
    const mint = (): string => {
      let id = `t.${String(next++)}`
      while (pinned.has(id)) id = `t.${String(next++)}`
      return id
    }
    const tabs = docTabsFrom(declared, mint)
    // No tabs declared is one tab, which is what autoLink already made:
    // every document has at least one, and a tabless one cannot be read.
    if (tabs.length > 0) doc.tabs = tabs
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

const KNOWN = new Set(['calendarTimeZone', 'calendars', 'docs', 'forms'])

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
    if (!isIanaZone(tz)) {
      throw new ResetBodyError(`/reset extras.calendarTimeZone is not a zone: ${tz}`)
    }
    // The primary calendar is a fixture row, so its zone is the fixture's
    // default until a reset says otherwise; retuning it here rather than
    // shipping a second fixture keeps one file per scenario.
    for (const cal of st.calendars.values()) if (cal.primary === true) cal.timeZone = tz
  }
  seedCalendars(st, listField('calendars', extras.calendars))
  seedDocs(st, listField('docs', extras.docs))
  seedForms(st, listField('forms', extras.forms))
}
