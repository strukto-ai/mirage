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

import {
  CHAR_MODE,
  ALL_MODE_BITS,
  DIR_MODE,
  FIFO_MODE,
  FILE_MODE,
  LINK_MODE,
} from '../../utils/stat_view.ts'
import { FileStat, FileType } from '../../types.ts'
import { lsModeString } from './utils/formatting.ts'
import { groupName, ownerName, type Identity } from './utils/identity.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { PrintfKind } from '../../core/generic/find_eval.ts'
import type { PrintfPart } from './types.ts'

// One mode per kind, spelled from the same constants every stat
// translator uses (utils/stat_view.ts); links are 777 the way ls draws
// them. A reported mode (chmod overlay, a backend that knows) supplies
// the permission bits; the kind always fixes the type bits.
const KIND_MODE: Record<PrintfKind, number> = {
  d: DIR_MODE,
  l: LINK_MODE,
  c: CHAR_MODE,
  p: FIFO_MODE,
  f: FILE_MODE,
}
const KIND_TYPE: Record<PrintfKind, FileType> = {
  d: FileType.DIRECTORY,
  l: FileType.SYMLINK,
  c: FileType.CHAR_DEVICE,
  p: FileType.FIFO,
  f: FileType.FILE,
}

function relativePart(row: string, base: string): string {
  if (row === base) return ''
  const stem = base.endsWith('/') ? base : base + '/'
  if (row.startsWith(stem)) return row.slice(stem.length)
  return row
}

function pad(n: number, width: number, fill = '0'): string {
  return String(n).padStart(width, fill)
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// Midnight UTC of a calendar day, its year as given: `Date.UTC` reads 0-99
// as 1900-1999.
function utcDay(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  return date
}

// The ISO 8601 week-numbering year and week of a UTC date.
function isoWeek(dt: Date): [number, number] {
  const thursday = utcDay(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((dt.getUTCDay() + 6) % 7))
  const year = thursday.getUTCFullYear()
  const week =
    1 + Math.floor((thursday.getTime() - utcDay(year, 0, 1).getTime()) / (7 * 86_400_000))
  return [year, week]
}

/**
 * Every `%T<letter>` GNU find renders, for one UTC timestamp. `%TS`, `%TT`
 * and `%TX` carry the fraction GNU appends. Mirrors Python's `_time_fields`.
 */
function timeFields(ts: number): Record<string, string> {
  const total = Math.round(ts * 1_000_000)
  const whole = Math.floor(total / 1_000_000)
  const dt = new Date(whole * 1000)
  const frac = `${pad(total - whole * 1_000_000, 6)}0000`
  const [isoYear, isoWeekNo] = isoWeek(dt)
  const year = dt.getUTCFullYear()
  const month = dt.getUTCMonth()
  const hour = dt.getUTCHours()
  const wday = dt.getUTCDay()
  const isoDay = wday === 0 ? 7 : wday
  const yday = Math.floor(
    (utcDay(year, month, dt.getUTCDate()).getTime() - utcDay(year, 0, 1).getTime()) / 86_400_000,
  )
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  const day = DAY_NAMES[wday] ?? ''
  const monthName = MONTH_NAMES[month] ?? ''
  const clock = `${pad(hour, 2)}:${pad(dt.getUTCMinutes(), 2)}:${pad(dt.getUTCSeconds(), 2)}`
  const date = `${pad(month + 1, 2)}/${pad(dt.getUTCDate(), 2)}/${pad(year % 100, 2)}`
  const meridiem = hour < 12 ? 'AM' : 'PM'
  return {
    '@': `${String(whole)}.${frac}`,
    '+': `${pad(year, 4)}-${pad(month + 1, 2)}-${pad(dt.getUTCDate(), 2)}+${clock}.${frac}`,
    a: day.slice(0, 3),
    A: day,
    b: monthName.slice(0, 3),
    B: monthName,
    c: `${day.slice(0, 3)} ${monthName.slice(0, 3)} ${pad(dt.getUTCDate(), 2, ' ')} ${clock} ${String(year)}`,
    C: pad(Math.floor(year / 100), 2),
    d: pad(dt.getUTCDate(), 2),
    D: date,
    e: pad(dt.getUTCDate(), 2, ' '),
    F: `${pad(year, 4)}-${pad(month + 1, 2)}-${pad(dt.getUTCDate(), 2)}`,
    g: pad(isoYear % 100, 2),
    G: String(isoYear),
    h: monthName.slice(0, 3),
    H: pad(hour, 2),
    I: pad(hour12, 2),
    j: pad(yday + 1, 3),
    k: pad(hour, 2, ' '),
    l: pad(hour12, 2, ' '),
    m: pad(month + 1, 2),
    M: pad(dt.getUTCMinutes(), 2),
    n: '\n',
    p: meridiem,
    P: meridiem.toLowerCase(),
    r: `${pad(hour12, 2)}:${pad(dt.getUTCMinutes(), 2)}:${pad(dt.getUTCSeconds(), 2)} ${meridiem}`,
    R: `${pad(hour, 2)}:${pad(dt.getUTCMinutes(), 2)}`,
    s: String(whole),
    S: `${pad(dt.getUTCSeconds(), 2)}.${frac}`,
    t: '\t',
    T: `${clock}.${frac}`,
    u: String(isoDay),
    U: pad(Math.floor((yday + 7 - wday) / 7), 2),
    V: pad(isoWeekNo, 2),
    w: String(wday),
    W: pad(Math.floor((yday + 7 - (isoDay - 1)) / 7), 2),
    x: date,
    X: `${clock}.${frac}`,
    y: pad(year % 100, 2),
    Y: String(year),
    z: '+0000',
    Z: 'UTC',
  }
}

export interface PrintfStatFacts {
  size: number
  kind: PrintfKind
  mtimeEpoch: number
  // The permission bits a backend or the namespace overlay reported,
  // null for the per-kind default.
  mode: number | null
  // What %Y classifies on a symlink row: the target's kind, 'N' when the
  // link dangles. Ignored for a non-link row, where %Y is %y.
  targetKind: PrintfKind | 'N' | null
  // The owner a backend or the attr overlay reported, null when none;
  // %u %U %g %G fall back to the session's identity from there.
  uid: number | string | null
  gid: number | string | null
}

function modeBits(st: PrintfStatFacts | null, kind: PrintfKind): number {
  const base = KIND_MODE[kind]
  const mode = st?.mode ?? null
  if (mode === null) return base
  return (base & ~ALL_MODE_BITS) | (mode & ALL_MODE_BITS)
}

// Render one compiled -printf format against one result row. Directives
// cover what GNU's find agents actually use: the path family (%p %P %f %h
// %d), the stat family (%s %y %Y %m %M), %T times, and the backslash
// escapes, which mirage-rs expanded when it compiled the format. Times
// render in UTC (mirage timestamps are zone-carrying ISO strings; GNU
// renders the local zone). %Y on a symlink row reports the target's kind,
// N when the link dangles; on any other row it is %y. Mirrors the Python
// expand_printf.
export function expandPrintf(
  parts: readonly PrintfPart[],
  row: string,
  startBase: string,
  st: PrintfStatFacts | null,
  identity: Identity | null = null,
): string {
  const kind = st === null ? 'f' : st.kind
  return parts
    .map((part) => {
      if ('lit' in part) return part.lit
      if ('time' in part) return timeFields(st === null ? 0 : st.mtimeEpoch)[part.time] ?? ''
      return directive(part.dir, row, startBase, st, identity, kind)
    })
    .join('')
}

function directive(
  code: string,
  row: string,
  startBase: string,
  st: PrintfStatFacts | null,
  identity: Identity | null,
  kind: PrintfKind,
): string {
  if (code === 'p') return row
  if (code === 'P') return relativePart(row, startBase)
  if (code === 'f') {
    const trimmed = rstripSlash(row)
    return trimmed === '' ? '/' : (trimmed.split('/').pop() ?? trimmed)
  }
  if (code === 'h') {
    const trimmed = rstripSlash(row)
    if (!trimmed.includes('/')) return trimmed === '' ? '/' : '.'
    const head = trimmed.slice(0, trimmed.lastIndexOf('/'))
    return head === '' ? '/' : head
  }
  if (code === 'd') {
    const rel = relativePart(row, startBase)
    return rel === '' ? '0' : String(rel.split('/').length)
  }
  if (code === 's') return String(st === null ? 0 : st.size)
  if (code === 'y') return st === null ? 'U' : kind
  if (code === 'Y') {
    if (st === null) return 'U'
    return kind === 'l' ? (st.targetKind ?? 'N') : kind
  }
  if (code === 'u' || code === 'U') return ownerName(st?.uid ?? null, identity)
  if (code === 'g' || code === 'G') return groupName(st?.gid ?? null, identity)
  if (code === 'm') return (modeBits(st, kind) & ALL_MODE_BITS).toString(8)
  const bits = modeBits(st, kind)
  return lsModeString(new FileStat({ name: '', type: KIND_TYPE[kind], mode: bits & ALL_MODE_BITS }))
}
