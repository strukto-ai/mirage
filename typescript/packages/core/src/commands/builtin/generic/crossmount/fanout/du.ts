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

import { humanSize } from '../../../utils/formatting.ts'
import { rollup, separateTotal } from '../../du.ts'
import { respellRaw } from '../../../../../utils/path.ts'
import type { OperandRun } from '../types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function formatSize(size: number, human: boolean): string {
  return human ? humanSize(size) : String(size)
}

function humanizeRow(line: string): string {
  const tab = line.indexOf('\t')
  if (tab < 0) return line
  return `${humanSize(Number(line.slice(0, tab)))}\t${line.slice(tab + 1)}`
}

// Strip each block's own total row and emit one global total.
//
// GNU `du -c` prints exactly one grand total, whatever it walked (pinned on
// coreutils 9.7: `du -c` over a directory holding a mount reports the mounted
// filesystem's bytes inside the one total). mirage reaches that number by
// concatenating runs, so each run's own total row (always its last) is removed
// here and the values re-summed.
//
// The callers force the runs to report exact bytes even under `-h`, and the
// sizes are humanized here instead. Summing already-humanized totals would
// round twice, so two 1500-byte operands read back as 1536 each and report
// `3.0K` where one mount says `2.9K`. Per-run totals cannot be replaced by
// summing the rows either: without `-a` a run prints a row per directory, and
// those nest.
export function mergeDuTotals(blocks: readonly Uint8Array[], human: boolean): Uint8Array {
  const kept: string[] = []
  let total = 0
  for (const data of blocks) {
    let body = DEC.decode(data)
      .split('\n')
      .filter((l) => l !== '')
    const last = body.at(-1)
    if (last?.endsWith('\ttotal') === true) {
      total += Number(last.slice(0, last.lastIndexOf('\t')))
      body = body.slice(0, -1)
    }
    kept.push(...(human ? body.map(humanizeRow) : body))
  }
  kept.push(`${formatSize(total, human)}\ttotal`)
  return ENC.encode(kept.join('\n') + '\n')
}

function parseRows(blocks: readonly Uint8Array[]): [string, number][] {
  const rows: [string, number][] = []
  for (const data of blocks) {
    for (const line of DEC.decode(data).split('\n')) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const sizeText = line.slice(0, tab)
      if (!/^\d+$/.test(sizeText)) continue
      rows.push([line.slice(tab + 1), Number(sizeText)])
    }
  }
  return rows
}

// Keep the rows nothing else sits under.
//
// The blocks are rendered text, which does not say which row is a file and
// which is a directory, but the shape does: a directory row is an ancestor of
// some other row. mirage never emits a row for an empty directory (no leaf
// points at one, the documented divergence), so a row with no descendants is a
// file. The one exception is a mount root, which is a directory even when the
// mount is empty, so those are named rather than inferred.
function leavesOf(
  rows: readonly [string, number][],
  mountRoots: readonly string[],
): [string, number][] {
  const paths = new Set(rows.map(([p]) => rstrip(p)))
  const known = new Set(mountRoots.map(rstrip))
  return rows.filter(
    ([p]) => !known.has(rstrip(p)) && ![...paths].some((o) => o.startsWith(rstrip(p) + '/')),
  )
}

function rstrip(path: string): string {
  return path.endsWith('/') && path !== '/' ? path.replace(/\/+$/, '') : path
}

// Fold per-mount du blocks into one tree, GNU's way.
//
// A nested mount's bytes belong to every directory above it, so the blocks
// cannot simply be concatenated: pinned on coreutils 9.7 over a real mount,
// `du base` prints `7 base/inner` then `17 base`, and `du -s base` prints the
// single row `17 base`, where concatenation reported the parent's own `10`.
// Only `-x`, which mirage does not implement, gives the unfolded number.
//
// The per-mount runs are asked for every row (`-a`, no `-s`, no depth limit) so
// the leaves survive the round trip; the tree is then derived once by the same
// `rollup` a single-mount run uses, so ordering, `--max-depth` pruning and the
// `-a` file rows all come out of one implementation rather than two.
export function mergeDuBlocks(
  blocks: readonly Uint8Array[],
  root: string,
  label: string,
  opts: {
    all: boolean
    summarize: boolean
    total: boolean
    human: boolean
    maxDepth: number | null
    // -S, a directory counts only the files that sit directly in it. The
    // per-mount runs are asked without it, because the merge needs their
    // leaves and applies it here.
    separateDirs?: boolean
    mountRoots?: readonly string[]
  },
): Uint8Array {
  const mountRoots = opts.mountRoots ?? []
  const leaves = leavesOf(parseRows(blocks), mountRoots)
  const sum = leaves.reduce((acc, [, size]) => acc + size, 0)
  // -S scopes to the operand's own row; GNU keeps the -c grand total
  // recursive (coreutils 9.7 over a real mount: `du -bSc base` prints
  // `3 base` then `10 total`).
  const own = opts.separateDirs === true ? separateTotal(leaves, root) : sum
  const lines: string[] = []
  if (!opts.summarize) {
    const rows = rollup(leaves, root, {
      all: opts.all,
      maxDepth: opts.maxDepth,
      dirs: mountRoots,
      separateDirs: opts.separateDirs === true,
    })
    const shown = respellRaw(
      rows.map(([node]) => node),
      root,
      label,
    )
    rows.forEach(([, size], i) => {
      lines.push(`${formatSize(size, opts.human)}\t${shown[i] ?? ''}`)
    })
  }
  lines.push(`${formatSize(own, opts.human)}\t${label}`)
  if (opts.total) lines.push(`${formatSize(sum, opts.human)}\ttotal`)
  return ENC.encode(lines.join('\n') + '\n')
}

// Re-total a per-operand fan-out, one native run per operand. Every native run
// receives `-c` so glob operands total natively.
export function duTotal(results: OperandRun[], human: boolean): Uint8Array {
  return mergeDuTotals(
    results.map((run) => run.data),
    human,
  )
}
