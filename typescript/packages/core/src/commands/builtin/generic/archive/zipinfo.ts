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

// Info-ZIP zipinfo's short-listing vocabulary (zipinfo.c, zi_short),
// indexed by the host byte of "version made by" and by compression
// method. A host past the table reads as the last "???" slot, as the
// MIN(host, NUM_HOSTS) clamp does there. Mirrors archive/zipinfo.py.
const HOSTS: readonly string[] = [
  'fat',
  'ami',
  'vms',
  'unx',
  'cms',
  'atr',
  'hpf',
  'mac',
  'zzz',
  'cpm',
  't20',
  'ntf',
  'qds',
  'aco',
  'vft',
  'mvs',
  'be ',
  'nsk',
  'ths',
  'osx',
  '???',
  '???',
  '???',
  '???',
  '???',
  '???',
  '???',
  '???',
  '???',
  '???',
  'ath',
  '???',
]
const METHODS: Readonly<Record<number, string>> = {
  0: 'stor',
  1: 'shrk',
  2: 're:1',
  3: 're:2',
  4: 're:3',
  5: 're:4',
  6: 'i#:#',
  7: 'tokn',
  8: 'def#',
  9: 'd64#',
  10: 'dcli',
  12: 'bzp2',
  14: 'lzma',
  18: 'ters',
  19: 'lz77',
  97: 'wavp',
  98: 'ppmd',
}
const DEFLATE_LEVELS = 'NXFS'
const MONTHS: readonly string[] = [
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
// Hosts whose external attributes are DOS attribute bytes rather than a
// Unix mode: FS_FAT_, VM_CMS_, FS_HPFS_, FS_NTFS_, ACORN_, FS_VFAT_,
// MVS_. VMS, Amiga and Theos have their own layouts in zipinfo.c and are
// rendered here as Unix modes, the "assume Unix-like" default branch.
const DOS_HOSTS: ReadonlySet<number> = new Set([0, 4, 6, 11, 13, 14, 15])
const UNIX_TIME_HOSTS: ReadonlySet<number> = new Set([3, 6, 11])
const DOS_EXECUTABLE_SUFFIXES: ReadonlySet<string> = new Set(['com', 'exe', 'btm', 'cmd', 'bat'])

/** One central-directory entry as zipinfo reads it. */
export interface ZipRow {
  /** The member name, directories with their trailing slash. */
  name: string
  /** Uncompressed size. */
  size: number
  /** Compressed size. */
  csize: number
  /** Compression method id. */
  method: number
  /** General-purpose bit flags. */
  flags: number
  /** Internal file attributes. */
  internalAttr: number
  /** The whole 32-bit external attributes word. */
  externalAttr: number
  /** The host byte of "version made by". */
  host: number
  /** The version byte of "version made by", in tenths. */
  hostVersion: number
  /**
   * The DOS stamp decoded as [year, month, day, hour, minute, second],
   * month and day left at 0 when the stamp is 0.
   */
  dateTime: readonly [number, number, number, number, number, number]
  /** Whether the central entry carries an extra field. */
  hasExtra: boolean
}

export type ZipinfoRows = 'none' | 'names' | 'short' | 'medium' | 'long'

/** What one zipinfo run prints: rows, header, totals. */
export interface ZipinfoLayout {
  rows: ZipinfoRows
  header: boolean
  totals: boolean
}

export interface ZipinfoRequest {
  /** `-1` */
  namesOnly: boolean
  /** `-2` */
  namesHeaders: boolean
  /** `-l` */
  long: boolean
  /** `-m` */
  medium: boolean
  /** `-s`, the default rows asked for by name. */
  short: boolean
  /** `-h` */
  header: boolean
  /** `-t` */
  totals: boolean
  /** Whether member or exclude patterns were given. */
  hasMembers: boolean
}

/**
 * Resolve zipinfo's -1/-2/-s/-m/-l/-h/-t interplay (zipinfo.c, zi_opts).
 *
 * -1 prints names and nothing else, whatever -h/-t say. -2 prints names
 * plus whichever of the header and totals was asked for. The row formats
 * default both on, except that naming members (or excluding some) turns
 * off the one not asked for explicitly. -h or -t alone (no row format)
 * prints just that, unless members are named, in which case the default
 * rows come too. Info-ZIP reads the letters in order and the last row
 * format wins; the flag bag has no order, so -1 beats -2 beats -l beats -m
 * beats -s here.
 */
export function zipinfoLayout(req: ZipinfoRequest): ZipinfoLayout {
  if (req.namesOnly) return { rows: 'names', header: false, totals: false }
  if (req.namesHeaders) return { rows: 'names', header: req.header, totals: req.totals }
  let rows: ZipinfoRows
  if (req.long) {
    rows = 'long'
  } else if (req.medium) {
    rows = 'medium'
  } else if (req.short) {
    rows = 'short'
  } else if (req.header || req.totals) {
    if (!req.hasMembers) return { rows: 'none', header: req.header, totals: req.totals }
    rows = 'short'
  } else {
    rows = 'short'
  }
  return {
    rows,
    header: !(req.hasMembers && !req.header),
    totals: !(req.hasMembers && !req.totals),
  }
}

const UNIX_KINDS: Readonly<Record<number, string>> = {
  0o040000: 'd',
  0o100000: '-',
  0o120000: 'l',
  0o060000: 'b',
  0o020000: 'c',
  0o010000: 'p',
  0o140000: 's',
}

const UNIX_TRIADS: readonly [number, number, number, number, string, string][] = [
  [0o400, 0o200, 0o100, 0o4000, 's', 'S'],
  [0o040, 0o020, 0o010, 0o2000, 's', 'S'],
  [0o004, 0o002, 0o001, 0o1000, 't', 'T'],
]

function unixAttribs(xattr: number): string {
  let out = UNIX_KINDS[xattr & 0o170000] ?? '?'
  for (const [read, write, exe, special, lower, upper] of UNIX_TRIADS) {
    out += xattr & read ? 'r' : '-'
    out += xattr & write ? 'w' : '-'
    if (xattr & exe) out += xattr & special ? lower : 'x'
    else out += xattr & special ? upper : '-'
  }
  return out
}

function dosAttribs(externalAttr: number, name: string): string {
  const lo = externalAttr & 0xff
  const out = '.r.-...'.split('')
  out[2] = lo & 0x01 ? '-' : 'w'
  out[5] = lo & 0x02 ? 'h' : '-'
  out[6] = lo & 0x04 ? 's' : '-'
  out[4] = lo & 0x20 ? 'a' : '-'
  if (lo & 0x10) {
    out[0] = 'd'
    out[3] = 'x'
  } else {
    out[0] = '-'
  }
  if (lo & 0x08) {
    out[0] = 'V'
  } else {
    const dot = name.lastIndexOf('.')
    const suffix = dot === -1 ? '' : name.slice(dot + 1)
    if (DOS_EXECUTABLE_SUFFIXES.has(suffix.slice(0, 3).toLowerCase())) out[3] = 'x'
  }
  return out.join('').padEnd(10, ' ')
}

function attribs(row: ZipRow): string {
  const xattr = (row.externalAttr >>> 16) & 0xffff
  // A FAT host whose Unix bits merely restate its DOS attribute byte
  // (read, write unless read-only, execute when a directory) has no mode
  // of its own to show, so zipinfo renders the DOS byte instead.
  const dosShadow = 0o400 | ((row.externalAttr & 1 ? 0 : 1) << 7) | ((row.externalAttr & 0x10) << 2)
  const perms =
    DOS_HOSTS.has(row.host) && (row.host !== 0 || (xattr & 0o700) !== dosShadow)
      ? dosAttribs(row.externalAttr, row.name)
      : unixAttribs(xattr)
  return `${perms}  ${String(Math.floor(row.hostVersion / 10))}.${String(row.hostVersion % 10)}`
}

function methodText(row: ZipRow): string {
  const text = METHODS[row.method]
  if (text === undefined) return `u${String(row.method).padStart(3, '0')}`
  if (row.method === 6) return `i${row.flags & 2 ? '8' : '4'}:${row.flags & 4 ? '3' : '2'}`
  if (row.method === 8 || row.method === 9)
    return text.slice(0, 3) + DEFLATE_LEVELS.charAt((row.flags >> 1) & 3)
  return text
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

function stamp(row: ZipRow): string {
  const [year, month, day, hour, minute] = row.dateTime
  const monthText = month > 0 && month <= 12 ? MONTHS[month - 1] : String(month).padStart(3, '0')
  return `${two(year % 100)}-${monthText ?? ''}-${two(day)} ${two(hour)}:${two(minute)}`
}

function kindFlags(row: ZipRow): string {
  const text = (row.internalAttr & 1) !== 0
  const first = row.flags & 1 ? (text ? 'T' : 'B') : text ? 't' : 'b'
  const extra = row.hasExtra || ((row.externalAttr & 0x8000) !== 0 && UNIX_TIME_HOSTS.has(row.host))
  const second = row.flags & 8 ? (extra ? 'X' : 'l') : extra ? 'x' : '-'
  return first + second
}

// Compressed bytes as zipinfo counts them: minus an encryption header.
function compressedOf(row: ZipRow): number {
  return row.csize - (row.flags & 1 ? 12 : 0)
}

/**
 * One `ls -l`-shaped zipinfo line.
 *
 * `medium` (-m) adds the percent saved, `long` (-l) the compressed size;
 * `short` (-s) is the bare row. The percent is `(ratio + 5) / 10` in C
 * integer division, which truncates toward zero, so a growth of -199.5%
 * prints as `-199%`.
 */
export function renderRow(row: ZipRow, fmt: ZipinfoRows): string {
  const host = HOSTS[Math.min(row.host, HOSTS.length - 1)] ?? '???'
  let line = `${attribs(row)} ${host} ${String(row.size).padStart(8, ' ')} ${kindFlags(row)}`
  if (fmt === 'medium') {
    const percent = Math.trunc((compressionRatio(row.size, compressedOf(row)) + 5) / 10)
    line += `${String(percent).padStart(3, ' ')}%`
  } else if (fmt === 'long') {
    line += ` ${String(row.csize).padStart(8, ' ')}`
  }
  return `${line} ${methodText(row)} ${stamp(row)} ${row.name}`
}

/** The two `-h` lines. */
export function renderHeader(archive: string, zipSize: number, entries: number): string {
  return `Archive:  ${archive}\nZip file size: ${String(zipSize)} bytes, number of entries: ${String(entries)}\n`
}

/** Info-ZIP's `ratio()`: tenths of a percent saved, rounded, signed. */
export function compressionRatio(uncompressed: number, compressed: number): number {
  if (uncompressed === 0) return 0
  if (uncompressed > 2_000_000) {
    const denom = Math.floor(uncompressed / 1000)
    if (uncompressed >= compressed)
      return Math.floor((uncompressed - compressed + (denom >> 1)) / denom)
    return -Math.floor((compressed - uncompressed + (denom >> 1)) / denom)
  }
  if (uncompressed >= compressed) {
    return Math.floor((1000 * (uncompressed - compressed) + (uncompressed >> 1)) / uncompressed)
  }
  return -Math.floor((1000 * (compressed - uncompressed) + (uncompressed >> 1)) / uncompressed)
}

/**
 * The `-t` line over the listed rows.
 *
 * An encrypted entry's 12-byte header is not counted as compressed data,
 * as zipinfo does not count it.
 */
export function renderTotals(rows: readonly ZipRow[]): string {
  let uncompressed = 0
  let compressed = 0
  for (const r of rows) {
    uncompressed += r.size
    compressed += compressedOf(r)
  }
  let ratio = compressionRatio(uncompressed, compressed)
  const sign = ratio < 0 ? '-' : ''
  ratio = Math.abs(ratio)
  const plural = rows.length === 1 ? '' : 's'
  return `${String(rows.length)} file${plural}, ${String(uncompressed)} bytes uncompressed, ${String(compressed)} bytes compressed:  ${sign}${String(Math.floor(ratio / 10))}.${String(ratio % 10)}%\n`
}
