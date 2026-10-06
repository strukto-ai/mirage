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

import { humanScaled, humanSize } from '../../../../commands/builtin/utils/formatting.ts'
import { CapacityState } from '../../../../types.ts'
import type { CapacityResult, PathSpec } from '../../../../types.ts'
import {
  dispatchStat,
  nearestAncestor,
  typedSpec,
} from '../../../../commands/builtin/utils/paths.ts'
import {
  enoent,
  enotdir,
  isDotWalkError,
  isMissingPath,
  walkRefusal,
} from '../../../../errors/fs.ts'
import { fsErrorLine } from '../../../../errors/render.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { MountEntry } from '../../../mount/mount.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import type { SessionState } from '../../../session/session.ts'
import { fail, ok, operandText, result, splitValueFlags } from '../shared.ts'
import { BLOCK_SUFFIX, SI_UNITS } from './constants.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { Result } from '../types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

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
    if (arg === undefined) break
    const s = operandText(arg)
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

// What stat-ing one FILE operand answers, null when it is there. GNU df
// stats each FILE to find its filesystem and names the one it cannot reach
// with the errno it got, so a plain file in the chain is ENOTDIR, told apart
// from an absent name by walking the chain on a miss, since a store answers
// both with ENOENT. Mirrors Python's _operand_error.
async function operandError(dispatch: DispatchFn, spec: PathSpec): Promise<Error | null> {
  const stat = dispatchStat(dispatch)
  try {
    await stat(spec)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOTDIR') return err as Error
    if (!isMissingPath(err)) throw err
    if (isDotWalkError(err)) return err
    const [, parentIsDir] = await nearestAncestor(stat, spec)
    return parentIsDir ? (err as Error) : enotdir(spec)
  }
  return null
}

// Human-readable size in powers of 1000 (df -H). Same rounding as -h;
// GNU runs both through one `human_readable`.
function humanSi(n: number): string {
  return humanScaled(n, 1000, SI_UNITS)
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
// reports the mount containing it. GNU df maps each FILE to its filesystem;
// one it cannot reach is reported in its own words and the rest still print,
// exit 1. Mirrors Python's _target_mounts.
async function targetMounts(
  registry: MountRegistry,
  dispatch: DispatchFn,
  session: SessionState,
  operands: (string | PathSpec)[],
): Promise<[MountEntry[], string[]]> {
  // Python is `sorted(registry.mounts(), key=lambda m: m.prefix)`.
  const ordered = [...registry.allMounts()].sort((a, b) => compareCodePoints(a.prefix, b.prefix))
  if (operands.length === 0) return [ordered, []]
  const seen = new Set<string>()
  const out: MountEntry[] = []
  const errors: string[] = []
  for (const op of operands) {
    const spec = typedSpec(op, session.cwd)
    if (spec.walkError !== null) {
      // The empty name reads as the working directory in `virtual`, which
      // may well be a mount root, and a link loop reaches no filesystem
      // at all.
      errors.push(fsErrorLine('df', spec, walkRefusal(spec)))
      continue
    }
    const virtual = spec.virtual
    if (virtual === '' || virtual === '/') {
      for (const m of ordered) {
        if (!seen.has(m.prefix)) {
          seen.add(m.prefix)
          out.push(m)
        }
      }
      continue
    }
    const mount = registry.tryMountFor(virtual)
    if (mount === null) {
      errors.push(fsErrorLine('df', spec, enoent(spec)))
      continue
    }
    // The mount root is the filesystem itself (always present); a deeper
    // path must be reachable before its mount is accepted.
    const root = rstripSlash(mount.prefix) || '/'
    if (rstripSlash(virtual) !== root || spec.dotted !== null) {
      const failure = await operandError(dispatch, spec)
      if (failure !== null) {
        errors.push(fsErrorLine('df', spec, failure))
        continue
      }
    }
    if (!seen.has(mount.prefix)) {
      seen.add(mount.prefix)
      out.push(mount)
    }
  }
  return [out, errors]
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
  session: SessionState,
  dispatch: DispatchFn,
  args: (string | PathSpec)[],
): Promise<Result> {
  const { flags, values, operands, bad } = splitValueFlags(args, 'hHkiaTP', 'B')
  if (bad !== null) return fail('df', `df: invalid option -- '${bad}'\n`, 2)

  const posix = flags.has('P')
  const bArg = values.get('B')
  let bParsed: [number, string] | null = null
  if (bArg !== undefined) {
    bParsed = parseBlock(bArg)
    if (bParsed === null) return fail('df', `df: invalid -B argument '${bArg}'\n`, 1)
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

  const [mounts, errors] = await targetMounts(registry, dispatch, session, operands)

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
    const cap = await mount.use(() => mount.vfs.capacity())
    const cells = [mount.vfs.name]
    if (showType) cells.push(mount.vfs.name)
    cells.push(...numCells(cap, human, si, block, inodes))
    cells.push(pctCell(cap, inodes))
    cells.push(rstripSlash(mount.prefix) || '/')
    data.push(cells)
  }

  const table = data.length > 0 ? encodeText(renderTable(header, data, showType)) : null
  if (errors.length > 0) {
    return result('df', { out: table, exitCode: 1, stderr: errors.join('') })
  }
  return ok('df', table)
}
