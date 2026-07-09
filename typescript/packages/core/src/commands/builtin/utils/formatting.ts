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

function lsModeString(s: FileStat): string {
  const isDir = s.type === FileType.DIRECTORY
  const typeChar = isDir ? 'd' : '-'
  const perms = isDir ? 'rwxr-xr-x' : 'rw-r--r--'
  return `${typeChar}${perms}`
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
    const size = padLeft(sizes[i] ?? '0', width)
    const time = lsTimeString(s.modified)
    return `${mode} 1 ${owner} ${group} ${size} ${time} ${s.name}`
  })
}
