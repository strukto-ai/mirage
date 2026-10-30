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

const PRINTF_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '\\': '\\',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
}
const STAT_DIRECTIVES = new Set(['s', 'y', 'Y', 'm', 'M', 'T', 'u', 'U', 'g', 'G'])
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

// Whether a -printf format reads anything off the entry's stat.
export function printfNeedsStat(fmt: string): boolean {
  let i = 0
  while (i < fmt.length - 1) {
    const ch = fmt.charAt(i)
    if (ch === '%' && STAT_DIRECTIVES.has(fmt.charAt(i + 1))) return true
    if (ch === '%' || ch === '\\') {
      i += 2
      continue
    }
    i += 1
  }
  return false
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

// The ISO 8601 week-numbering year and week of a UTC date.
function isoWeek(dt: Date): [number, number] {
  const thursday = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()))
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((dt.getUTCDay() + 6) % 7))
  const year = thursday.getUTCFullYear()
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000))
  return [year, week]
}

/**
 * Every `%T<letter>` GNU find renders, for one UTC timestamp. `%TS`, `%TT`
 * and `%TX` carry the fraction GNU appends. Mirrors Python's `_time_fields`.
 */
function timeFields(ts: number): Record<string, string> {
  const dt = new Date(ts * 1000)
  const frac = ts.toFixed(10).split('.')[1] ?? '0000000000'
  const [isoYear, isoWeekNo] = isoWeek(dt)
  const year = dt.getUTCFullYear()
  const month = dt.getUTCMonth()
  const hour = dt.getUTCHours()
  const wday = dt.getUTCDay()
  const isoDay = wday === 0 ? 7 : wday
  const yday = Math.floor(
    (Date.UTC(year, month, dt.getUTCDate()) - Date.UTC(year, 0, 1)) / 86_400_000,
  )
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  const day = DAY_NAMES[wday] ?? ''
  const monthName = MONTH_NAMES[month] ?? ''
  const clock = `${pad(hour, 2)}:${pad(dt.getUTCMinutes(), 2)}:${pad(dt.getUTCSeconds(), 2)}`
  const date = `${pad(month + 1, 2)}/${pad(dt.getUTCDate(), 2)}/${pad(year % 100, 2)}`
  const meridiem = hour < 12 ? 'AM' : 'PM'
  return {
    '@': ts.toFixed(10),
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
    s: String(Math.floor(ts)),
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

function warnUnrecognized(src: string, warnings: string[]): void {
  const kind = src.startsWith('\\') ? 'escape' : 'format directive'
  const line = `find: warning: unrecognized ${kind} '${src}'`
  if (!warnings.includes(line)) warnings.push(line)
}

// Expand one -printf format against one result row. Directives cover what
// GNU's find agents actually use: the path family (%p %P %f %h %d), the
// stat family (%s %y %Y %m %M), %T times, and the backslash escapes. An
// unrecognized directive or escape renders literally and adds GNU's
// warning line once, exit code untouched -- which is GNU's own behavior.
// Times render in UTC (mirage timestamps are zone-carrying ISO strings;
// GNU renders the local zone). %Y on a symlink row reports the target's
// kind, N when the link dangles; on any other row it is %y. Mirrors the
// Python expand_printf.
export function expandPrintf(
  fmt: string,
  row: string,
  startBase: string,
  st: PrintfStatFacts | null,
  warnings: string[],
  identity: Identity | null = null,
): string {
  const out: string[] = []
  let i = 0
  const n = fmt.length
  const kind = st === null ? 'f' : st.kind
  while (i < n) {
    const ch = fmt.charAt(i)
    if (ch === '\\' && i + 1 < n) {
      const nxt = fmt.charAt(i + 1)
      const mapped = PRINTF_ESCAPES[nxt]
      if (mapped !== undefined) {
        out.push(mapped)
      } else {
        warnUnrecognized(`\\${nxt}`, warnings)
        out.push(fmt.slice(i, i + 2))
      }
      i += 2
      continue
    }
    if (ch !== '%' || i + 1 >= n) {
      out.push(ch)
      i += 1
      continue
    }
    const code = fmt.charAt(i + 1)
    i += 2
    if (code === '%') {
      out.push('%')
    } else if (code === 'p') {
      out.push(row)
    } else if (code === 'P') {
      out.push(relativePart(row, startBase))
    } else if (code === 'f') {
      const trimmed = rstripSlash(row)
      out.push(trimmed === '' ? '/' : (trimmed.split('/').pop() ?? trimmed))
    } else if (code === 'h') {
      const trimmed = rstripSlash(row)
      if (!trimmed.includes('/')) {
        out.push(trimmed === '' ? '/' : '.')
      } else {
        const head = trimmed.slice(0, trimmed.lastIndexOf('/'))
        out.push(head === '' ? '/' : head)
      }
    } else if (code === 'd') {
      const rel = relativePart(row, startBase)
      out.push(rel === '' ? '0' : String(rel.split('/').length))
    } else if (code === 's') {
      out.push(String(st === null ? 0 : st.size))
    } else if (code === 'y') {
      out.push(st === null ? 'U' : kind)
    } else if (code === 'Y') {
      if (st === null) {
        out.push('U')
      } else if (kind === 'l') {
        out.push(st.targetKind ?? 'N')
      } else {
        out.push(kind)
      }
    } else if (code === 'u' || code === 'U') {
      out.push(ownerName(st?.uid ?? null, identity))
    } else if (code === 'g' || code === 'G') {
      out.push(groupName(st?.gid ?? null, identity))
    } else if (code === 'm') {
      out.push((modeBits(st, kind) & ALL_MODE_BITS).toString(8))
    } else if (code === 'M') {
      const bits = modeBits(st, kind)
      out.push(
        lsModeString(new FileStat({ name: '', type: KIND_TYPE[kind], mode: bits & ALL_MODE_BITS })),
      )
    } else if (code === 'T' && i < n) {
      const letter = fmt.charAt(i)
      i += 1
      const rendered = timeFields(st === null ? 0 : st.mtimeEpoch)[letter]
      if (rendered !== undefined) {
        out.push(rendered)
      } else if (/^[A-Za-z0-9]$/.test(letter)) {
        // GNU prints a letter or digit it has no field for as `%<char>`,
        // silently; anything else is an unrecognized directive.
        out.push(`%${letter}`)
      } else {
        warnUnrecognized(`%T${letter}`, warnings)
        out.push(`%T${letter}`)
      }
    } else {
      warnUnrecognized(`%${code}`, warnings)
      out.push(`%${code}`)
    }
  }
  return out.join('')
}
