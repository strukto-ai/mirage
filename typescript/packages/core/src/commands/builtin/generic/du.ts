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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { formatRecords } from '../utils/output.ts'
import { humanSize } from '../utils/formatting.ts'

function depthOf(entryPath: string, basePath: string): number {
  const base = rstripSlash(basePath)
  const rel = rstripSlash(entryPath).slice(base.length)
  if (!rel) return 0
  return (stripSlash(rel).match(/\//g) ?? []).length + 1
}

export async function duGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  computeTotal: (p: PathSpec) => Promise<number>,
  computeAll: (p: PathSpec) => Promise<[[string, number][], number]>,
): Promise<CommandFnResult> {
  const human = opts.flags.h === true
  const all = opts.flags.a === true
  const cumulative = opts.flags.c === true
  const summarize = opts.flags.s === true
  const maxDepthRaw = opts.flags['max-depth']
  const maxDepth = typeof maxDepthRaw === 'string' ? Number.parseInt(maxDepthRaw, 10) : null
  const targets =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            resourcePath: '',
            virtual: '/',
            directory: '/',
            resolved: false,
          }),
        ]
  const fmt = (size: number): string => (human ? humanSize(size) : String(size))
  const lines: string[] = []
  let grand = 0
  for (const root of targets) {
    if (all && !summarize) {
      try {
        const [entries, total] = await computeAll(root)
        const filtered =
          maxDepth !== null
            ? entries.filter(([p]) => depthOf(p, root.virtual) <= maxDepth)
            : entries
        for (const [p, size] of filtered) lines.push(`${fmt(size)}\t${p}`)
        lines.push(`${fmt(total)}\t${root.display}`)
        grand += total
      } catch {
        lines.push(`${fmt(0)}\t${root.display}`)
      }
    } else {
      let total = 0
      try {
        total = await computeTotal(root)
      } catch {
        total = 0
      }
      lines.push(`${fmt(total)}\t${root.display}`)
      grand += total
    }
  }
  if (cumulative) {
    lines.push(`${fmt(grand)}\ttotal`)
  }
  const out: ByteSource = formatRecords(lines)
  return [out, new IOResult()]
}

// Fallback for backends with no native du op: one recursive-total line per
// operand, computed by walking stat/readdir. Mirrors the Python du_multi path
// (compute_all=None), so -a/-s/--max-depth collapse to a single summary line.
export async function duMulti(
  paths: PathSpec[],
  opts: CommandOpts,
  computeTotal: (p: PathSpec) => Promise<number>,
): Promise<CommandFnResult> {
  const human = opts.flags.h === true
  const cumulative = opts.flags.c === true
  const targets =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            resourcePath: '',
            virtual: '/',
            directory: '/',
            resolved: false,
          }),
        ]
  const fmt = (size: number): string => (human ? humanSize(size) : String(size))
  const lines: string[] = []
  let grand = 0
  for (const root of targets) {
    let total = 0
    try {
      total = await computeTotal(root)
    } catch {
      total = 0
    }
    lines.push(`${fmt(total)}\t${root.display}`)
    grand += total
  }
  if (cumulative) {
    lines.push(`${fmt(grand)}\ttotal`)
  }
  return [formatRecords(lines), new IOResult()]
}
