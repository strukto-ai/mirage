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

import { TICK_MS } from '../../kit/typescript/index.ts'
import type {
  CalendarEntry,
  CalendarEvent,
  DocBody,
  DriveEntry,
  DriveItem,
  FormDoc,
  GmailLabel,
  GmailMessage,
  Presentation,
  Spreadsheet,
} from './types.ts'

export const SYSTEM_LABELS = ['INBOX', 'SENT', 'UNREAD', 'TRASH']

// Non-UTC on purpose: a UTC default would hide exactly the day-bucketing
// bugs this mock exists to catch. /reset can pin a different one.
export const DEFAULT_CALENDAR_TZ = 'Asia/Hong_Kong'
export const PRIMARY_CALENDAR_ID = 'integ@example.com'

export const ID_WIDTH = 4
export const EVENT_ID_WIDTH = 23

// ONE TENANT'S WORLD, in the shapes the handlers and renderers read.
//
// This is a working copy, not the store: `loadState` fills it from the tenant's
// rows at the top of a request and `saveState` writes it back at the bottom of
// a write. SQLite is the authority between requests, which is what buys the
// per-run persistence, the scoped /reset and the seeded-template copy that the
// in-memory version could not have.
//
// Whole-world load and whole-world flush, rather than per-entity queries in
// each handler, for two reasons. The Router serializes writes per run and makes
// a read wait for them, so read-modify-write of a whole tenant is atomic here
// in a way it would not be in a server that answered concurrently. And the
// alternative asks 38 handlers to remember to persist what they just mutated,
// where forgetting is silent: the request that mutated still answers correctly
// from the object in hand, and only the NEXT request sees the loss. A fake's
// world is bounded by its fixture, so paying for the whole of it is the cheaper
// side of that trade.
//
// The clock and the mint counters are gws's own here, not the kit's Clock and
// Minter, because both have to survive into a template copy; see Meta and
// Counter in integ/prisma/gws.prisma.
export class GwsState {
  files = new Map<string, DriveItem>()
  drives = new Map<string, DriveEntry>()
  docs = new Map<string, DocBody>()
  sheets = new Map<string, Spreadsheet>()
  presentations = new Map<string, Presentation>()
  messages = new Map<string, GmailMessage>()
  labels = new Map<string, GmailLabel>()
  calendars = new Map<string, CalendarEntry>()
  events = new Map<string, Map<string, CalendarEvent>>()
  forms = new Map<string, FormDoc>()
  counters = new Map<string, number>()
  readonly epochMs: number
  ticks: number

  constructor(epochMs: number, ticks = 0) {
    this.epochMs = epochMs
    this.ticks = ticks
  }

  // Per kind, so a new Doc does not advance the next file id.
  next(kind: string): number {
    const n = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, n)
    return n
  }

  // Zero-padded per kind, which is what every gws truth file already spells;
  // the kit's own `{kind}_new_{n}` format has no padding, so the width is
  // applied here rather than through Minter.mint.
  nextId(kind: string): string {
    return `${kind}${String(this.next(kind)).padStart(ID_WIDTH, '0')}`
  }

  // Real Google event ids are 26 chars of base32hex (0-9a-v); filenames on a
  // gcal mount embed them, so the mock must produce the real shape, not a
  // short counter. Deterministic so integ truth files stay stable.
  nextEventId(): string {
    return `evt${String(this.next('event')).padStart(EVENT_ID_WIDTH, '0')}`
  }

  // Frozen at the epoch with a +1s tick per touch, which is the kit Clock's
  // arithmetic; only the storage differs.
  nowMs(): number {
    this.ticks += 1
    return this.epochMs + this.ticks * TICK_MS
  }

  now(): string {
    return new Date(this.nowMs()).toISOString()
  }
}
