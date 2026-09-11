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

import { DIR_MODE, FILE_MODE } from '../../utils/stat_view.ts'
import { FileStat, FileType } from '../../types.ts'
import { lsModeString } from './utils/formatting.ts'
import { groupName, ownerName, type Identity } from './utils/identity.ts'

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
  l: 0o120777,
  c: 0o020666,
  f: FILE_MODE,
}
const KIND_TYPE: Record<PrintfKind, FileType> = {
  d: FileType.DIRECTORY,
  l: FileType.SYMLINK,
  c: FileType.CHAR_DEVICE,
  f: FileType.FILE,
}
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

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

function timeDirective(letter: string, ts: number): string | null {
  if (letter === '@') return ts.toFixed(10)
  const dt = new Date(ts * 1000)
  const frac = ts.toFixed(10).split('.')[1] ?? '0000000000'
  switch (letter) {
    case '+':
      return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}+${pad(dt.getUTCHours(), 2)}:${pad(dt.getUTCMinutes(), 2)}:${pad(dt.getUTCSeconds(), 2)}.${frac}`
    case 'Y':
      return pad(dt.getUTCFullYear(), 4)
    case 'y':
      return pad(dt.getUTCFullYear() % 100, 2)
    case 'm':
      return pad(dt.getUTCMonth() + 1, 2)
    case 'd':
      return pad(dt.getUTCDate(), 2)
    case 'e':
      return String(dt.getUTCDate()).padStart(2, ' ')
    case 'H':
      return pad(dt.getUTCHours(), 2)
    case 'M':
      return pad(dt.getUTCMinutes(), 2)
    case 'S':
      return pad(dt.getUTCSeconds(), 2)
    case 'j': {
      const start = Date.UTC(dt.getUTCFullYear(), 0, 0)
      return pad(Math.floor((dt.getTime() - start) / 86_400_000), 3)
    }
    case 'a':
      return DAY_ABBR[dt.getUTCDay()] ?? ''
    case 'b':
    case 'h':
      return MONTH_ABBR[dt.getUTCMonth()] ?? ''
    case 'p':
      return dt.getUTCHours() < 12 ? 'AM' : 'PM'
    default:
      return null
  }
}

export type PrintfKind = 'f' | 'd' | 'l' | 'c'

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

export function printfKind(st: FileStat): PrintfKind {
  if (st.type === FileType.DIRECTORY) return 'd'
  if (st.type === FileType.SYMLINK) return 'l'
  if (st.type === FileType.CHAR_DEVICE) return 'c'
  return 'f'
}

function modeBits(st: PrintfStatFacts | null, kind: PrintfKind): number {
  const base = KIND_MODE[kind]
  const mode = st?.mode ?? null
  if (mode === null) return base
  return (base & ~0o7777) | (mode & 0o7777)
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
      const trimmed = row.replace(/\/+$/, '')
      out.push(trimmed === '' ? '/' : (trimmed.split('/').pop() ?? trimmed))
    } else if (code === 'h') {
      const trimmed = row.replace(/\/+$/, '')
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
      out.push((modeBits(st, kind) & 0o7777).toString(8))
    } else if (code === 'M') {
      const bits = modeBits(st, kind)
      out.push(lsModeString(new FileStat({ name: '', type: KIND_TYPE[kind], mode: bits & 0o7777 })))
    } else if (code === 'T' && i < n) {
      const letter = fmt.charAt(i)
      i += 1
      const rendered = timeDirective(letter, st === null ? 0 : st.mtimeEpoch)
      if (rendered === null) {
        warnUnrecognized(`%T${letter}`, warnings)
        out.push(`%T${letter}`)
      } else {
        out.push(rendered)
      }
    } else {
      warnUnrecognized(`%${code}`, warnings)
      out.push(`%${code}`)
    }
  }
  return out.join('')
}
