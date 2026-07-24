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

import { humanSize } from '../../../commands/builtin/utils/formatting.ts'
import { IOResult } from '../../../io/types.ts'
import { CapacityState, FileStat, PathSpec } from '../../../types.ts'
import type { CapacityResult } from '../../../types.ts'
import { resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { DispatchFn } from '../cross_mount.ts'
import type { MountEntry } from '../../mount/mount.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import { splitValueFlags } from './metadata.ts'
import type { Result } from './scope.ts'

const SI_UNITS = ['B', 'K', 'M', 'G', 'T']
const BLOCK_SUFFIX: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
}

function errorResult(message: string, exitCode: number): Result {
  const err = new TextEncoder().encode(message)
  return [
    null,
    new IOResult({ exitCode, stderr: err }),
    new ExecutionNode({ command: 'df', exitCode, stderr: err }),
  ]
}

function textResult(out: string): Result {
  return [
    new TextEncoder().encode(out),
    new IOResult(),
    new ExecutionNode({ command: 'df', exitCode: 0 }),
  ]
}

// Parse a -B/--block-size argument into [bytes, header-label]; a plain byte
// count or a 1024-based suffix (K/M/G/T), labelled after the raw argument.
function parseBlock(text: string): [number, string] | null {
  const t = text.trim()
  if (t.length === 0) return null
  const suffix = t.slice(-1).toUpperCase()
  let value: number
  if (suffix in BLOCK_SUFFIX) {
    const head = t.slice(0, -1) || '1'
    if (!/^\d+$/.test(head)) return null
    value = parseInt(head, 10) * (BLOCK_SUFFIX[suffix] ?? 1)
  } else if (/^\d+$/.test(t)) {
    value = parseInt(t, 10)
  } else {
    return null
  }
  // GNU rejects a zero (or non-positive) block size rather than scaling.
  if (value <= 0) return null
  return [value, t]
}

// The last size-format flag (-h/-H/-k/-B) in the leading option run. GNU df
// lets a later size flag override the earlier ones (`df -h -B1M` prints a
// block header, `df -B1M -h` prints `Size`), so the display format is
// whichever appears last. Returns the flag letter, or null when none appear.
function lastFormat(args: (string | PathSpec)[]): string | null {
  let last: string | null = null
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    const s = typeof arg === 'string' ? arg : ''
    if (s === '--' || !(s.length >= 2 && s.startsWith('-') && s[1] !== '-')) break
    const body = s.slice(1)
    for (let j = 0; j < body.length; j++) {
      const c = body[j]
      if (c === 'h' || c === 'H' || c === 'k' || c === 'B') last = c
      if (c === 'B') {
        if (body.slice(j + 1).length === 0) i += 1
        break
      }
    }
    i += 1
  }
  return last
}

// Whether a path resolves to an existing entry; GNU df errors on a missing
// FILE operand, so a deeper path is statted before its mount is accepted.
async function pathExists(dispatch: DispatchFn, spec: PathSpec): Promise<boolean> {
  try {
    const [stat] = await dispatch('stat', spec)
    return stat instanceof FileStat
  } catch {
    return false
  }
}

// Human-readable size in powers of 1000 (df -H), mirroring the 1024
// `humanSize` shape used by df -h / du -h.
function humanSi(n: number): string {
  let value = n
  let i = 0
  while (value >= 1000 && i < SI_UNITS.length - 1) {
    value /= 1000
    i += 1
  }
  const text = i === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${text}${SI_UNITS[i] ?? ''}`
}

// Bytes as a count of `block`-byte units, rounded up like GNU df.
function scale(nbytes: number, block: number): string {
  return String(Math.ceil(nbytes / block))
}

// GNU df use-percent: ceil(used / (used + avail) * 100), or `-` when the
// denominator is zero.
function usePct(used: number, avail: number): string {
  const denom = used + avail
  if (denom <= 0) return '-'
  return `${String(Math.ceil((used * 100) / denom))}%`
}

// The three numeric cells (block or inode) for one mount, or three `-` when
// capacity is not a known quota (never a fabricated 0).
function numCells(
  cap: CapacityResult,
  human: boolean,
  si: boolean,
  block: number,
  inodes: boolean,
): string[] {
  const quota = cap.state === CapacityState.QUOTA
  if (inodes) {
    if (quota && cap.inodes != null) {
      return [String(cap.inodes), String(cap.inodesUsed ?? 0), String(cap.inodesFree ?? 0)]
    }
    return ['-', '-', '-']
  }
  if (quota && cap.total != null) {
    const used = cap.used ?? 0
    const avail = cap.available ?? 0
    if (human) {
      const fmt = si ? humanSi : humanSize
      return [fmt(cap.total), fmt(used), fmt(avail)]
    }
    return [scale(cap.total, block), scale(used, block), scale(avail, block)]
  }
  return ['-', '-', '-']
}

// The Use%/IUse% cell for one mount, or `-` outside a known quota.
function pctCell(cap: CapacityResult, inodes: boolean): string {
  if (cap.state !== CapacityState.QUOTA) return '-'
  if (inodes) {
    if (cap.inodes == null) return '-'
    return usePct(cap.inodesUsed ?? 0, cap.inodesFree ?? 0)
  }
  if (cap.total == null) return '-'
  return usePct(cap.used ?? 0, cap.available ?? 0)
}

// Resolve df operands to the mounts to report, deduped and ordered. No
// operand (or the workspace root `/`) reports every mount; a path operand
// reports the mount containing it. Null when an operand maps to no mount.
async function targetMounts(
  registry: MountRegistry,
  dispatch: DispatchFn,
  session: Session,
  operands: (string | PathSpec)[],
): Promise<MountEntry[] | { missing: string }> {
  const ordered = [...registry.allMounts()].sort((a, b) => a.prefix.localeCompare(b.prefix))
  if (operands.length === 0) return ordered
  const seen = new Set<string>()
  const out: MountEntry[] = []
  for (const op of operands) {
    const virtual = op instanceof PathSpec ? op.virtual : resolvePath(op, session.cwd)
    const label = op instanceof PathSpec ? op.rawPath : op
    const spec = op instanceof PathSpec ? op : PathSpec.fromStrPath(virtual)
    if (virtual === '' || virtual === '/') {
      for (const m of ordered) {
        if (!seen.has(m.prefix)) {
          seen.add(m.prefix)
          out.push(m)
        }
      }
      continue
    }
    const mount = registry.mountFor(virtual)
    if (mount === null) {
      return { missing: label }
    }
    // The mount root is the filesystem itself (always present); a deeper
    // path must exist, matching GNU df's per-FILE check.
    const root = rstripSlash(mount.prefix) || '/'
    if (rstripSlash(virtual) !== root && !(await pathExists(dispatch, spec))) {
      return { missing: label }
    }
    if (!seen.has(mount.prefix)) {
      seen.add(mount.prefix)
      out.push(mount)
    }
  }
  return out
}

// GNU df column layout: Filesystem left-justified (min width 14), Type (when
// present) left, numeric columns right-justified, Mounted on left with no
// trailing pad, single-space separators.
function renderTable(header: string[], rows: string[][], showType: boolean): string {
  const ncols = header.length
  const left = new Set<number>([0, ncols - 1])
  if (showType) left.add(1)
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length), 0),
  )
  widths[0] = Math.max(widths[0] ?? 0, 14)
  const lines: string[] = []
  for (const cells of [header, ...rows]) {
    const parts: string[] = []
    for (let c = 0; c < ncols; c++) {
      const cell = cells[c] ?? ''
      const w = widths[c] ?? 0
      if (c === ncols - 1) parts.push(cell)
      else if (left.has(c)) parts.push(cell.padEnd(w))
      else parts.push(cell.padStart(w))
    }
    lines.push(parts.join(' '))
  }
  return lines.join('\n') + '\n'
}

// df [OPTION]... [FILE]...: report per-mount capacity. A mount reports real
// numbers only when its backend can; every other backend shows `-` rather
// than a fabricated total.
export async function handleDf(
  registry: MountRegistry,
  session: Session,
  dispatch: DispatchFn,
  args: (string | PathSpec)[],
): Promise<Result> {
  const { flags, values, operands, bad } = splitValueFlags(args, 'hHkiaTP', 'B')
  if (bad !== null) return errorResult(`df: invalid option -- '${bad}'\n`, 2)

  const posix = flags.has('P')
  const bArg = values.get('B')
  let bParsed: [number, string] | null = null
  if (bArg !== undefined) {
    bParsed = parseBlock(bArg)
    if (bParsed === null) return errorResult(`df: invalid -B argument '${bArg}'\n`, 1)
  }

  // GNU resolves the mutually overriding size flags last-wins, so -h/-H
  // (human) or -k/-B (block) is chosen by whichever appears last.
  const lf = lastFormat(args)
  const si = lf === 'H'
  const human = lf === 'h' || lf === 'H'
  let block = 1024
  let blockLabel = posix ? '1024-blocks' : '1K-blocks'
  if (lf === 'B' && bParsed !== null) {
    block = bParsed[0]
    blockLabel = `${bParsed[1]}-blocks`
  }

  const inodes = flags.has('i')
  const showType = flags.has('T')

  const mounts = await targetMounts(registry, dispatch, session, operands)
  if (!Array.isArray(mounts)) {
    return errorResult(`df: ${mounts.missing}: No such file or directory\n`, 1)
  }

  let numHeaders: string[]
  let pctHeader: string
  if (inodes) {
    numHeaders = ['Inodes', 'IUsed', 'IFree']
    pctHeader = 'IUse%'
  } else if (human) {
    numHeaders = ['Size', 'Used', 'Avail']
    pctHeader = 'Use%'
  } else {
    numHeaders = [blockLabel, 'Used', 'Available']
    pctHeader = posix ? 'Capacity' : 'Use%'
  }

  const header = ['Filesystem']
  if (showType) header.push('Type')
  header.push(...numHeaders, pctHeader, 'Mounted on')

  const data: string[][] = []
  for (const mount of mounts) {
    const cap = mount.resource.statfs
      ? await mount.resource.statfs()
      : { state: CapacityState.UNKNOWN }
    const cells = [mount.resource.kind]
    if (showType) cells.push(mount.resource.kind)
    cells.push(...numCells(cap, human, si, block, inodes))
    cells.push(pctCell(cap, inodes))
    cells.push(mount.prefix.replace(/\/+$/, '') || '/')
    data.push(cells)
  }

  return textResult(renderTable(header, data, showType))
}
