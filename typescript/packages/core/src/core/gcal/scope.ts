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

import { EVENT_SUFFIX } from '../../resource/gcal/event_entry.ts'
import { ContentType } from '../../types.ts'
import { Codec } from '../hierarchy/codec.ts'
import { Scope, Slot, makeDetectScope } from '../hierarchy/scope.ts'
import { validDay } from './day.ts'

/** Whether a segment is shaped like an event filename. */
export function isEventName(text: string): boolean {
  return text.endsWith(EVENT_SUFFIX)
}

// A calendar day is a real date, not merely date-shaped: 2026-02-30 must
// classify as invalid, or stat reports a directory every later call raises
// on.
export const DAY = new Codec({ validate: validDay })
// The whole filename stays in the slot (no suffix strip): the id and the
// HHMM label are recovered by parseEventFilename, which needs the name as
// listed.
export const EVENT_NAME = new Codec({ validate: isEventName })

const CAL: readonly (string | Slot)[] = [new Slot('calendar')]
const DAY_SEGS: readonly (string | Slot)[] = [...CAL, new Slot('day', DAY)]

// One description of the tree: readdir, stat, read and unlink all classify
// through it, so the file surface and the write surface cannot disagree
// about what a path means. The calendar level is a plain name ("primary",
// or `label__id`), proven against the calendar list rather than decoded.
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'calendar', segments: CAL }),
  new Scope({
    kind: 'calendar_json',
    segments: [...CAL, 'calendar.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'day', segments: DAY_SEGS }),
  new Scope({
    kind: 'event',
    segments: [...DAY_SEGS, new Slot('event', EVENT_NAME)],
    leaf: true,
    filetype: ContentType.JSON,
  }),
]

export const detectScope = makeDetectScope(SCOPES)
