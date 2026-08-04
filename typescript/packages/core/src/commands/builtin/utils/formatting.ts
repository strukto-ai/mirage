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

import { FileType, LINK_TARGET_KEY, type FileStat } from '../../../types.ts'
import { DEFAULT_MODES, EPOCH_LS_TIME, MONTHS, NUMERIC_PREFIX, TYPE_CHARS } from './constants.ts'

export function humanSize(n: number): string {
  const units = ['B', 'K', 'M', 'G', 'T']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  const s = i === 0 ? Math.round(value).toString() : value.toFixed(1)
  return `${s}${units[i] ?? ''}`
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
  const typeChar = (s.type != null ? TYPE_CHARS[s.type] : undefined) ?? '-'
  const mode = s.mode ?? (s.type != null ? (DEFAULT_MODES[s.type] ?? 0o644) : 0o644)
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

function lsTimeString(modified: string | null | undefined): string {
  if (modified === null || modified === undefined || modified === '') {
    return EPOCH_LS_TIME
  }
  const t = Date.parse(modified)
  if (Number.isNaN(t)) return EPOCH_LS_TIME
  const d = new Date(t)
  const month = MONTHS[d.getUTCMonth()] ?? 'Jan'
  const day = padLeft(String(d.getUTCDate()), 2)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${month} ${day} ${hh}:${mm}`
}

export interface LsLongOptions {
  human?: boolean
  owner?: string
  group?: string
  sizeWidth?: number
}

// The name column: GNU appends `-> target` for a symlink row.
function lsName(s: FileStat): string {
  if (s.type !== FileType.SYMLINK) return s.name
  const target = s.extra[LINK_TARGET_KEY]
  return typeof target === 'string' && target !== '' ? `${s.name} -> ${target}` : s.name
}

export function formatLsLong(stats: readonly FileStat[], opts: LsLongOptions = {}): string[] {
  const owner = opts.owner ?? 'user'
  const group = opts.group ?? 'user'
  const human = opts.human ?? false
  const sizes = stats.map((s) => (human ? humanSize(s.size ?? 0) : String(s.size ?? 0)))
  const width = opts.sizeWidth ?? sizes.reduce((m, s) => Math.max(m, s.length), 1)
  return stats.map((s, i) => {
    const mode = lsModeString(s)
    // Metadata-less entries (synthetic API-backend directories) render the
    // compact placeholder form instead of inventing size 0 + epoch mtime,
    // mirroring the python formatter.
    if (s.size == null && s.modified == null) {
      return `${mode}\t-\t-\t${lsName(s)}`
    }
    const size = padLeft(sizes[i] ?? '0', width)
    const time = lsTimeString(s.modified)
    const who = s.uid !== null ? String(s.uid) : owner
    const grp = s.gid !== null ? String(s.gid) : group
    return `${mode} 1 ${who} ${grp} ${size} ${time} ${lsName(s)}`
  })
}

export function toNumber(val: string): number {
  const m = NUMERIC_PREFIX.exec(val.trim())
  return m === null ? 0 : Number.parseFloat(m[0])
}
