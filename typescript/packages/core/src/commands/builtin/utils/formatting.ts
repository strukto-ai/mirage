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
  DEVICE_NUMBERS_KEY,
  FileType,
  LINK_TARGET_KEY,
  type FileStat,
  type LsTimeKind,
} from '../../../types.ts'
import { strftime } from './strftime.ts'
import { UTC_ZONE } from '../../../utils/timezone.ts'
import {
  DEFAULT_MODES,
  EPOCH_LS_TIME,
  FIND_FUTURE_SECONDS,
  FIND_LS_ESCAPES,
  FIND_OLD_SECONDS,
  LS_RECENT_SECONDS,
  MONTHS,
  NUMERIC_PREFIX,
  TYPE_CHARS,
} from './constants.ts'
import { UNKNOWN_NAME, groupName, ownerName, type Identity } from './identity.ts'

// What a stat field a VFS cannot know renders as, in `stat -c` and in
// the inode and block columns of `find -ls`.
export const UNKNOWN_STAT_FIELD = '?'

// GNU's --block-size units: the letter and its power; K prints as K for
// KiB and kB for KB.
const BLOCK_UNITS = 'KMGTPEZYRQ'
export const LS_TIME_STYLES: readonly string[] = ['full-iso', 'long-iso', 'iso', 'locale']
const EPOCH = new Date(0)

/** How --block-size scales the size column: bytes per printed unit
 * (sizes round up), the suffix GNU prints after the count, and the
 * human base (1024 for human-readable, 1000 for si) when it is one of
 * the two -h scales instead of a fixed divisor. */
export interface BlockSize {
  readonly divisor: number
  readonly suffix: string
  readonly humanBase: number | null
}

/** Which columns an `ls` row carries and how its time is spelled: -g
 * drops the owner, -o the group; -i leads with the inode column and -Z
 * puts the context column before the size, both `?` since a VFS has
 * neither; timeKind picks the timestamp; timeStyle is `locale` (GNU's
 * six-month rule), `full-iso`, `long-iso`, `iso` or `+FORMAT`. */
export interface LsColumns {
  readonly owner: boolean
  readonly group: boolean
  readonly inode: boolean
  readonly context: boolean
  readonly timeKind: LsTimeKind
  readonly timeStyle: string
  readonly blockSize: BlockSize | null
}

export const DEFAULT_COLUMNS: LsColumns = Object.freeze({
  owner: true,
  group: true,
  inode: false,
  context: false,
  timeKind: 'mtime',
  timeStyle: 'locale',
  blockSize: null,
})

// GNU's --block-size=SIZE grammar, null when the text is not one:
// human-readable and si pick the two -h scales; otherwise an optional
// count is followed by an optional unit letter, B making it decimal (KB
// is 1000 and prints kB) and iB keeping it binary. A zero count is
// refused under any unit, as GNU refuses 0K the way it refuses 0.
export function parseBlockSize(text: string): BlockSize | null {
  if (text === 'human-readable') return { divisor: 1024, suffix: '', humanBase: 1024 }
  if (text === 'si') return { divisor: 1000, suffix: '', humanBase: 1000 }
  let i = 0
  while (i < text.length && /[0-9]/.test(text[i] ?? '')) i += 1
  const count = i > 0 ? Number(text.slice(0, i)) : 1
  if (count === 0) return null
  const unit = text.slice(i)
  if (unit === '') return i > 0 ? { divisor: count, suffix: '', humanBase: null } : null
  const letter = (unit[0] ?? '').toUpperCase()
  const rest = unit.slice(1)
  const power = BLOCK_UNITS.indexOf(letter) + 1
  if (power === 0) return null
  if (rest === '')
    return { divisor: count * 1024 ** power, suffix: count === 1 ? letter : '', humanBase: null }
  if (rest === 'B') {
    const shown = (letter === 'K' ? 'k' : letter) + 'B'
    return { divisor: count * 1000 ** power, suffix: count === 1 ? shown : '', humanBase: null }
  }
  if (rest === 'iB')
    return { divisor: count * 1024 ** power, suffix: count === 1 ? letter : '', humanBase: null }
  return null
}

// The size column under -h or --block-size, bytes otherwise.
export function scaledSize(n: number, block: BlockSize | null, human: boolean): string {
  if (block === null) return human ? humanSize(n) : String(n)
  if (block.humanBase === 1000) return humanScaled(n, 1000, ['', 'k', 'M', 'G', 'T', 'P', 'E'])
  if (block.humanBase !== null) return humanSize(n)
  return `${String(Math.ceil(n / block.divisor))}${block.suffix}`
}

/**
 * GNU's `human_readable` rounding, shared by `-h` and `-H`.
 *
 * Three rules, none of which fall out of a plain divide-and-format.
 * Below one unit GNU prints the count alone -- `24`, never `24B`. Above
 * it the value is rounded *up* to the precision shown, so 1025 bytes is
 * `1.1K` rather than `1.0K`. And the decimal is dropped once the scaled
 * value reaches ten, giving `10K` rather than `10.0K`. Rounding up can
 * carry past the base (1048575 bytes ceils to 1024K, which GNU shows as
 * `1.0M`), so the unit is re-chosen after rounding instead of once up
 * front.
 *
 * @param n byte count
 * @param base 1024 for `-h`, 1000 for `-H`
 * @param units suffixes indexed by power; index 0 is unused because a
 *   sub-unit count carries no suffix at all
 */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

export function humanScaled(n: number, base: number, units: readonly string[]): string {
  if (n < base) return String(n)
  // BigInt, not number: `n * 10` leaves the safe-integer range a little
  // under a petabyte, and the product silently rounds down before the
  // ceiling, which then lands on the wrong tenth -- 1914029841632461
  // bytes read `1.7P` where GNU and Python say `1.8P`. Python does this
  // in arbitrary-precision ints, so BigInt is the faithful mirror rather
  // than a workaround. A count this large is integral; truncating guards
  // the BigInt conversion against a fractional caller.
  const value = BigInt(Math.trunc(n))
  const big = BigInt(base)
  let i = 1
  let divisor = big
  for (;;) {
    const tenths = ceilDiv(value * 10n, divisor)
    if (tenths < 100n) {
      const unit = (tenths / 10n).toString()
      const decimal = (tenths % 10n).toString()
      return `${unit}.${decimal}${units[i] ?? ''}`
    }
    const whole = ceilDiv(value, divisor)
    if (whole < big || i === units.length - 1) return `${whole.toString()}${units[i] ?? ''}`
    i += 1
    divisor *= big
  }
}

export function humanSize(n: number): string {
  return humanScaled(n, 1024, ['', 'K', 'M', 'G', 'T', 'P', 'E'])
}

function permTriplet(bits: number, special?: string): string {
  const execBit =
    special !== undefined
      ? bits & 1
        ? special.toLowerCase()
        : special.toUpperCase()
      : bits & 1
        ? 'x'
        : '-'
  return (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + execBit
}

export function lsModeString(s: FileStat): string {
  const typeChar = TYPE_CHARS[s.type] ?? '-'
  const mode = s.mode ?? DEFAULT_MODES[s.type] ?? 0o644
  return (
    typeChar +
    permTriplet(mode >> 6, mode & 0o4000 ? 's' : undefined) +
    permTriplet(mode >> 3, mode & 0o2000 ? 's' : undefined) +
    permTriplet(mode, mode & 0o1000 ? 't' : undefined)
  )
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s
}

// The time column: `Mon DD HH:MM` for a recent time, `Mon DD  YYYY` for an
// old or future one, as GNU prints it. `findRule` uses findutils' window
// (old past 180 days, future past an hour) rather than ls's (the last
// half year, never the future).
// A stat timestamp as a Date, null when unknown or unreadable.
function parseWhen(modified: string | null | undefined): Date | null {
  if (modified === null || modified === undefined || modified === '') return null
  const t = Date.parse(modified)
  return Number.isNaN(t) ? null : new Date(t)
}

// GNU's "recent" test: within the last half year and not in the future
// for ls, findutils' wider window for `find -ls`.
function isRecent(when: number, findRule: boolean): boolean {
  const now = Date.now() / 1000
  if (findRule) return !(now > when + FIND_OLD_SECONDS || when > now + FIND_FUTURE_SECONDS)
  return now - LS_RECENT_SECONDS < when && when < now
}

function lsTimeString(modified: string | null | undefined, findRule = false): string {
  const d = parseWhen(modified)
  if (d === null) return EPOCH_LS_TIME
  const month = MONTHS[d.getUTCMonth()] ?? 'Jan'
  const day = padLeft(String(d.getUTCDate()), 2)
  if (!isRecent(d.getTime() / 1000, findRule))
    return `${month} ${day}  ${String(d.getUTCFullYear())}`
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${month} ${day} ${hh}:${mm}`
}

// The time column under --time-style. full-iso, long-iso and iso are
// GNU's three ISO shapes (iso pads its year form to the width of its
// recent form, which is where its trailing space comes from); +FORMAT is
// a date format, and one holding a newline names two, the first for a
// time outside the recent window and the second for one inside it. An
// unknown time renders the epoch, as the default style does.
export function styledTime(modified: string | null | undefined, style: string): string {
  if (style === 'locale') return lsTimeString(modified)
  const dt = parseWhen(modified) ?? EPOCH
  if (style === 'full-iso') return strftime(dt, '%Y-%m-%d %H:%M:%S.%N %z', UTC_ZONE)
  if (style === 'long-iso') return strftime(dt, '%Y-%m-%d %H:%M', UTC_ZONE)
  const recent = isRecent(dt.getTime() / 1000, false)
  if (style === 'iso') return strftime(dt, recent ? '%m-%d %H:%M' : '%Y-%m-%d ', UTC_ZONE)
  const fmt = style.slice(1)
  const cut = fmt.indexOf('\n')
  if (cut === -1) return strftime(dt, fmt, UTC_ZONE)
  return strftime(dt, recent ? fmt.slice(cut + 1) : fmt.slice(0, cut), UTC_ZONE)
}

// The timestamp an ls column shows for one row. A backend reports one
// clock, so the access time falls back to the modification time and the
// status-change time is the modification time (a plain write moves both
// together on POSIX); a birth time is something no backend here reports,
// so it stays unknown.
export function timeOf(s: FileStat, kind: LsTimeKind): string | null {
  if (kind === 'atime') return s.atime ?? s.modified ?? null
  if (kind === 'birth') return null
  return s.modified ?? null
}

// What -i and -Z put in front of a short row: `?` for each, since a VFS
// has neither an inode nor a security context.
export function lsPrefix(columns: LsColumns): string {
  let out = ''
  if (columns.inode) out += `${UNKNOWN_STAT_FIELD} `
  if (columns.context) out += `${UNKNOWN_STAT_FIELD} `
  return out
}

export interface LsLongOptions {
  human?: boolean
  // Who the session is; null outside a workspace, where both the owner
  // and the group column fall back to `-`.
  identity?: Identity | null
  sizeWidth?: number
  // Which columns to carry and how to spell the time.
  columns?: LsColumns
  // The name column per row when the caller decorated it
  // (--hyperlink), else the row's own.
  names?: readonly string[]
}

// The name column: GNU appends `-> target` for a symlink row.
export function lsName(s: FileStat): string {
  if (s.type !== FileType.SYMLINK) return s.name
  const target = s.extra[LINK_TARGET_KEY]
  return typeof target === 'string' && target !== '' ? `${s.name} -> ${target}` : s.name
}

// The size and time columns of one `ls -l` row. A device row carries its
// major and minor numbers where GNU puts them. An entry with neither a
// size nor a time (a synthetic API-backend directory) shows `-` in both
// rather than inventing size 0 and the epoch, mirroring the python
// formatter.
function lsSizeAndTime(
  s: FileStat,
  human: boolean,
  findRule = false,
  columns: LsColumns = DEFAULT_COLUMNS,
): [string, string] {
  const whenIso = timeOf(s, columns.timeKind)
  // An unknown modification time renders the epoch, as it always has;
  // only a kind no backend reports at all (birth) is honestly `-`.
  const knownTime = columns.timeKind !== 'birth'
  const renderTime = (): string =>
    !knownTime
      ? UNKNOWN_NAME
      : findRule
        ? lsTimeString(whenIso, true)
        : styledTime(whenIso, columns.timeStyle)
  const device = s.extra[DEVICE_NUMBERS_KEY]
  if (Array.isArray(device) && device.length === 2) {
    return [
      `${String(device[0])}, ${String(device[1])}`,
      whenIso === null ? UNKNOWN_NAME : renderTime(),
    ]
  }
  if (s.size == null && s.modified == null) return [UNKNOWN_NAME, UNKNOWN_NAME]
  return [scaledSize(s.size ?? 0, columns.blockSize, human), renderTime()]
}

// `ls -l` rows: mode, links, owner, group, size, time, name. The owner is
// the entry's uid when a backend or the attr overlay reports one, else
// the workspace user; the group is the gid, else the session's profile;
// `-` when nothing names one.
export function formatLsLong(stats: readonly FileStat[], opts: LsLongOptions = {}): string[] {
  const identity = opts.identity ?? null
  const human = opts.human ?? false
  const columns = opts.columns ?? DEFAULT_COLUMNS
  const cells = stats.map((s) => lsSizeAndTime(s, human, false, columns))
  const width = opts.sizeWidth ?? cells.reduce((m, [size]) => Math.max(m, size.length), 1)
  return stats.map((s, i) => {
    const [rawSize, time] = cells[i] ?? [UNKNOWN_NAME, UNKNOWN_NAME]
    const fields = [lsModeString(s), '1']
    if (columns.owner) fields.push(ownerName(s.uid, identity))
    if (columns.group) fields.push(groupName(s.gid, identity))
    if (columns.context) fields.push(UNKNOWN_STAT_FIELD)
    fields.push(padLeft(rawSize, width), time, opts.names?.[i] ?? lsName(s))
    const lead = columns.inode ? `${UNKNOWN_STAT_FIELD} ` : ''
    return lead + fields.join(' ')
  })
}

/**
 * One `find -ls` row in findutils' own layout. GNU's `list_file` is not
 * `ls -l`: it leads with the inode and the allocated 1K blocks, then
 * fixes every column's width (inode 9, blocks 6, links 3, owner and
 * group 8 left-aligned, size 8) instead of fitting them to the listing,
 * so a consumer can count fields. The inode and block columns carry
 * `?`, the answer `stat %i` and `%b` already give: a VFS has no inode
 * and no block allocation, and a number invented for either would read
 * as a fact. The remaining columns are the `ls -l` ones, from the same
 * helpers, so the two listings cannot disagree about a row; only the
 * name is spelled differently, escaped (`escapeFindName`) so the row
 * stays one line of fixed fields. `s` is the row named as find printed
 * it; `identity` is null outside a workspace, where both name columns
 * fall back to `-`.
 */
/**
 * Spell a name the way `find -ls` prints it. findutils escapes a name so
 * one row stays one line and its fields stay in place: a backslash, a
 * space and a double quote take a backslash, the C escapes stand for
 * their control characters, and every other control character and every
 * byte outside ASCII is an octal escape (`\303\274` for `ü`, as GNU
 * prints it in the C locale). `-print` is untouched; only the listing is
 * a table.
 */
export function escapeFindName(text: string): string {
  let out = ''
  for (const ch of text) {
    const escaped = FIND_LS_ESCAPES[ch]
    if (escaped !== undefined) out += escaped
    else if (ch > ' ' && ch < '\x7f') out += ch
    else
      for (const byte of new TextEncoder().encode(ch))
        out += `\\${byte.toString(8).padStart(3, '0')}`
  }
  return out
}

// The name column of a `find -ls` row, escaped, with the link target
// escaped the same way.
function findLsName(s: FileStat): string {
  const name = escapeFindName(s.name)
  if (s.type !== FileType.SYMLINK) return name
  const target = s.extra[LINK_TARGET_KEY]
  return typeof target === 'string' && target !== '' ? `${name} -> ${escapeFindName(target)}` : name
}

export function formatFindLs(s: FileStat, identity: Identity | null): string {
  const [size, time] = lsSizeAndTime(s, false, true)
  const who = ownerName(s.uid, identity)
  const grp = groupName(s.gid, identity)
  return (
    `${padLeft(UNKNOWN_STAT_FIELD, 9)} ${padLeft(UNKNOWN_STAT_FIELD, 6)} ` +
    `${lsModeString(s)} ${padLeft('1', 3)} ${who.padEnd(8)} ${grp.padEnd(8)} ` +
    `${padLeft(size, 8)} ${time} ${findLsName(s)}`
  )
}

export function toNumber(val: string): number {
  const m = NUMERIC_PREFIX.exec(val.trim())
  return m === null ? 0 : Number.parseFloat(m[0])
}
