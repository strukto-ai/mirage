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

import type { Accessor } from '../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../cache/index/index.ts'
import { isJsonlPath, isStreamableJsonlExpr } from '../../../core/jq/index.ts'
import { Precision, ProvisionResult } from '../../../provision/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandOpts, ProvisionFn } from '../../config.ts'
import type { StatOp } from './adapter.ts'

async function resolveSizes<A extends Accessor>(
  stat: StatOp<A>,
  accessor: A,
  paths: PathSpec[],
  index: IndexCacheStore | null,
): Promise<[[string, number][], number]> {
  const resolved: [string, number][] = []
  let missing = 0
  for (const p of paths) {
    let size: number | null = null
    if (index !== null) {
      const lookup = await index.get(p.virtual)
      if (lookup.entry !== undefined && lookup.entry !== null) {
        size = lookup.entry.size ?? null
      }
    }
    if (size === null) {
      try {
        const fileStat = await stat(accessor, p)
        size = fileStat.size ?? null
      } catch {
        // unresolved paths degrade precision below
      }
    }
    if (size !== null) resolved.push([p.virtual, size])
    else missing += 1
  }
  return [resolved, missing]
}

/** Cost estimate for full file reads (cat, wc, sort, ...), generic over stat. */
export function makeFileReadProvision<A extends Accessor>(stat: StatOp<A>): ProvisionFn<A> {
  return async (accessor: A, paths: PathSpec[], _texts: string[], opts: CommandOpts) => {
    const command = opts.command ?? ''
    if (paths.length === 0) {
      return new ProvisionResult({ command, precision: Precision.UNKNOWN })
    }
    const [resolved, missing] = await resolveSizes(stat, accessor, paths, opts.index ?? null)
    const total = resolved.reduce((acc, [, size]) => acc + size, 0)
    if (missing > 0 || resolved.length === 0) {
      // Sizes we could not resolve (virtual/rendered files) are carried
      // as UNKNOWN precision; the totals are floors.
      return new ProvisionResult({
        command,
        networkReadLow: total,
        networkReadHigh: total,
        readOps: paths.length,
        precision: Precision.UNKNOWN,
      })
    }
    return new ProvisionResult({
      command,
      networkReadLow: total,
      networkReadHigh: total,
      readOps: resolved.length,
      precision: Precision.EXACT,
    })
  }
}

/** Cost estimate for partial reads (head, tail), generic over stat. */
export function makeHeadTailProvision<A extends Accessor>(stat: StatOp<A>): ProvisionFn<A> {
  return async (accessor: A, paths: PathSpec[], _texts: string[], opts: CommandOpts) => {
    const command = opts.command ?? ''
    if (paths.length === 0) {
      return new ProvisionResult({ command, precision: Precision.UNKNOWN })
    }
    const [resolved, missing] = await resolveSizes(stat, accessor, paths, opts.index ?? null)
    const full = resolved.reduce((acc, [, size]) => acc + size, 0)
    if (missing > 0 || resolved.length === 0) {
      return new ProvisionResult({
        command,
        networkReadLow: 0,
        networkReadHigh: full,
        readOps: paths.length,
        precision: Precision.UNKNOWN,
      })
    }
    const c = opts.flags.c
    if (typeof c === 'string') {
      const cBytes = Number.parseInt(c, 10)
      const total = resolved.reduce((acc, [, size]) => acc + Math.min(cBytes, size), 0)
      return new ProvisionResult({
        command,
        networkReadLow: total,
        networkReadHigh: total,
        readOps: resolved.length,
        precision: Precision.EXACT,
      })
    }
    return new ProvisionResult({
      command,
      networkReadLow: 0,
      networkReadHigh: full,
      readOps: resolved.length,
      precision: Precision.RANGE,
    })
  }
}

/** Cost estimate for metadata-only ops (stat, ls, find). */
export function metadataProvision(
  _accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<ProvisionResult> {
  const n = Math.max(1, paths.length)
  return Promise.resolve(
    new ProvisionResult({
      command: opts.command ?? '',
      networkReadLow: 0,
      networkReadHigh: 0,
      readOps: n,
      precision: Precision.EXACT,
    }),
  )
}

/** Cost estimate for stat: the command string, no reads. */
export function statProvision(
  _accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  _opts: CommandOpts,
): Promise<ProvisionResult> {
  const first = paths[0]
  return Promise.resolve(
    new ProvisionResult({
      command: first !== undefined ? `stat ${first.virtual}` : 'stat',
    }),
  )
}

/** Provision for jq: streamable jsonl reads a range, else the whole file. */
export function makeJqProvision<A extends Accessor>(stat: StatOp<A>): ProvisionFn<A> {
  return async (accessor: A, paths: PathSpec[], texts: string[], opts: CommandOpts) => {
    const p = paths[0]
    const expr = texts[0]
    if (p === undefined || expr === undefined) {
      return new ProvisionResult({ command: 'jq', precision: Precision.UNKNOWN })
    }
    let fileStat
    try {
      fileStat = await stat(accessor, p)
    } catch {
      return new ProvisionResult({ command: 'jq', precision: Precision.UNKNOWN })
    }
    void opts
    const rendered = `jq '${expr}' ${p.virtual}`
    if (fileStat.size === null) {
      return new ProvisionResult({
        command: rendered,
        readOps: 1,
        precision: Precision.UNKNOWN,
      })
    }
    const fileSize = fileStat.size
    if (isJsonlPath(p.mountPath) && isStreamableJsonlExpr(expr)) {
      return new ProvisionResult({
        command: rendered,
        networkReadLow: 0,
        networkReadHigh: fileSize,
        readOps: 1,
        precision: Precision.RANGE,
      })
    }
    return new ProvisionResult({
      command: rendered,
      networkReadLow: fileSize,
      networkReadHigh: fileSize,
      readOps: 1,
      precision: Precision.EXACT,
    })
  }
}

/** Provision for grep/rg: render the pattern then delegate to file_read. */
export function makeSearchProvision<A extends Accessor>(stat: StatOp<A>): ProvisionFn<A> {
  const base = makeFileReadProvision(stat)
  return (accessor: A, paths: PathSpec[], texts: string[], opts: CommandOpts) => {
    const rendered = [opts.command ?? '', ...texts, ...paths.map((p) => p.virtual)].join(' ')
    return base(accessor, paths, texts, { ...opts, command: rendered })
  }
}

export const FILE_READ_COMMANDS: ReadonlySet<string> = new Set([
  'awk',
  'base64',
  'cat',
  'cmp',
  'column',
  'comm',
  'cut',
  'diff',
  'expand',
  'fmt',
  'fold',
  'join',
  'look',
  'md5',
  'nl',
  'paste',
  'rev',
  'sha256sum',
  'shuf',
  'sort',
  'strings',
  'tac',
  'tr',
  'tsort',
  'unexpand',
  'uniq',
  'wc',
  'xxd',
  'zcat',
])
export const HEAD_TAIL_COMMANDS: ReadonlySet<string> = new Set(['head', 'tail'])
export const SEARCH_COMMANDS: ReadonlySet<string> = new Set(['grep', 'rg', 'zgrep'])
export const METADATA_COMMANDS: ReadonlySet<string> = new Set([
  'basename',
  'dirname',
  'du',
  'find',
  'ls',
  'readlink',
  'realpath',
  'tree',
])

/**
 * Default cost estimator for a factory-built command, by family. Whole-file
 * readers stat their operands and charge the byte total; searches charge a
 * worst-case full read; metadata commands charge op counts only. Write
 * commands and anything unlisted return null so the planner reports
 * UNKNOWN. A backend disables a default by passing an explicit null in
 * provisionOverrides.
 */
export function defaultProvision<A extends Accessor>(
  name: string,
  stat: StatOp<A>,
): ProvisionFn<A> | null {
  if (FILE_READ_COMMANDS.has(name)) return makeFileReadProvision(stat)
  if (HEAD_TAIL_COMMANDS.has(name)) return makeHeadTailProvision(stat)
  if (SEARCH_COMMANDS.has(name)) return makeSearchProvision(stat)
  if (METADATA_COMMANDS.has(name)) return metadataProvision
  if (name === 'jq') return makeJqProvision(stat)
  if (name === 'stat') return statProvision
  return null
}
