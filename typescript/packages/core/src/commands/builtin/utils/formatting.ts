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

import { FileType, type FileStat } from '../../../types.ts'

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
}

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

// Invert humanSize: `4.0K` -> 4096, plain digits pass through.
export function parseSize(text: string): number {
  const last = text.at(-1) ?? ''
  const unit = SIZE_UNITS[last]
  if (unit !== undefined) return Math.round(parseFloat(text.slice(0, -1)) * unit)
  return parseInt(text, 10)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
  const isDir = s.type === FileType.DIRECTORY
  const typeChar = isDir ? 'd' : '-'
  const mode = s.mode ?? (isDir ? 0o755 : 0o644)
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
    return 'Jan  1 00:00'
  }
  const t = Date.parse(modified)
  if (Number.isNaN(t)) return 'Jan  1 00:00'
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
      return `${mode}\t-\t-\t${s.name}`
    }
    const size = padLeft(sizes[i] ?? '0', width)
    const time = lsTimeString(s.modified)
    const who = s.uid !== null ? String(s.uid) : owner
    const grp = s.gid !== null ? String(s.gid) : group
    return `${mode} 1 ${who} ${grp} ${size} ${time} ${s.name}`
  })
}

const NUMERIC_PREFIX = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/

export function toNumber(val: string): number {
  const m = NUMERIC_PREFIX.exec(val.trim())
  return m === null ? 0 : Number.parseFloat(m[0])
}
