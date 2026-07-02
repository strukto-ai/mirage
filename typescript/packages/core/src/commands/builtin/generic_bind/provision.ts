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
import { RegisteredCommand } from '../../config.ts'
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

/**
 * Provision for read-transform-write commands (gzip, tar, split). The
 * operands are read fully, so the read side is a known floor, but the
 * output size (compression ratio, piece count) is unknowable before
 * running, so precision stays UNKNOWN.
 */
export function makeTransformProvision<A extends Accessor>(stat: StatOp<A>): ProvisionFn<A> {
  const base = makeFileReadProvision(stat)
  return async (accessor: A, paths: PathSpec[], texts: string[], opts: CommandOpts) => {
    const result = (await base(accessor, paths, texts, opts)) as ProvisionResult
    result.precision = Precision.UNKNOWN
    return result
  }
}

/**
 * Provision for cp: bytes bracket 0 (server-side copy) to the total.
 * Reads the source sizes and reports both networkRead and networkWrite
 * as a 0..total range: a same-backend copy can be server-side (zero
 * client bytes) while a streamed copy moves the full byte count each way.
 */
export function makeCopyProvision<A extends Accessor>(stat: StatOp<A>): ProvisionFn<A> {
  return async (accessor: A, paths: PathSpec[], _texts: string[], opts: CommandOpts) => {
    const command = opts.command ?? ''
    const sources = paths.length > 1 ? paths.slice(0, -1) : paths
    if (sources.length === 0) {
      return new ProvisionResult({ command, precision: Precision.UNKNOWN })
    }
    const [resolved, missing] = await resolveSizes(stat, accessor, sources, opts.index ?? null)
    const total = resolved.reduce((acc, [, size]) => acc + size, 0)
    const precision = missing > 0 || resolved.length === 0 ? Precision.UNKNOWN : Precision.RANGE
    return new ProvisionResult({
      command,
      networkReadLow: 0,
      networkReadHigh: total,
      networkWriteLow: 0,
      networkWriteHigh: total,
      readOps: sources.length,
      precision,
    })
  }
}

/**
 * Provision for metadata-only writes (rm, mkdir, touch, ln). These never
 * move content bytes on any backend; the op count is the operand count.
 * A recursive rm walks an unknown subtree, so its op count is only a
 * floor and precision degrades to UNKNOWN.
 */
export function writeMetadataProvision(
  _accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<ProvisionResult> {
  const n = Math.max(1, paths.length)
  const recursive = opts.flags.r === true || opts.flags.R === true
  return Promise.resolve(
    new ProvisionResult({
      command: opts.command ?? '',
      networkReadLow: 0,
      networkReadHigh: 0,
      readOps: n,
      precision: recursive ? Precision.UNKNOWN : Precision.EXACT,
    }),
  )
}

/** Provision for pure local computation (seq, date, bc): zero cost. */
export function pureProvision(
  _accessor: Accessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<ProvisionResult> {
  return Promise.resolve(
    new ProvisionResult({ command: opts.command ?? '', precision: Precision.EXACT }),
  )
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
  'iconv',
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
// file reads a bounded prefix (magic bytes), so it shares head/tail's
// 0..size range estimate.
export const HEAD_TAIL_COMMANDS: ReadonlySet<string> = new Set(['file', 'head', 'tail'])
export const SEARCH_COMMANDS: ReadonlySet<string> = new Set(['grep', 'rg', 'zgrep'])
export const METADATA_COMMANDS: ReadonlySet<string> = new Set([
  'basename',
  'dirname',
  'du',
  'find',
  'ls',
  'readlink',
  'realpath',
  'stat',
  'tree',
])
export const TRANSFORM_COMMANDS: ReadonlySet<string> = new Set([
  'csplit',
  'gunzip',
  'gzip',
  'patch',
  'split',
  'tar',
  'unzip',
  'zip',
])
export const WRITE_METADATA_COMMANDS: ReadonlySet<string> = new Set([
  'ln',
  'mkdir',
  'mktemp',
  'rm',
  'touch',
])

/**
 * Default cost estimator for a factory-built command, by family. Whole-file
 * readers stat their operands and charge the byte total; searches charge a
 * worst-case full read; metadata commands charge op counts only; transforms
 * keep the read floor with UNKNOWN output; cp brackets 0..total on both
 * read and write; metadata writes are zero-byte op counts. mv, tee, and
 * anything unlisted return null so the planner reports UNKNOWN (mv may be
 * a free rename or a full cross-mount copy; tee's stdin size is
 * unknowable). A backend disables a default by passing an explicit null in
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
  if (TRANSFORM_COMMANDS.has(name)) return makeTransformProvision(stat)
  if (WRITE_METADATA_COMMANDS.has(name)) return writeMetadataProvision
  if (name === 'cp') return makeCopyProvision(stat)
  if (name === 'jq') return makeJqProvision(stat)
  return null
}

/**
 * Attach family defaults to hand-written commands. Bespoke backends (e.g.
 * opfs) register commands one by one instead of through the factory; this
 * gives every command without an explicit provision the same default the
 * factory would pick, so estimates match factory-built backends.
 */
export function withDefaultProvisions<A extends Accessor>(
  commands: readonly RegisteredCommand[],
  stat: StatOp<A>,
): RegisteredCommand[] {
  return commands.map((c) => {
    if (c.filetype !== null || c.provisionFn !== null) return c
    const provision = defaultProvision(c.name, stat)
    if (provision === null) return c
    return new RegisteredCommand({
      name: c.name,
      spec: c.spec,
      resource: c.resource,
      filetype: c.filetype,
      fn: c.fn,
      provisionFn: provision as ProvisionFn,
      aggregate: c.aggregate,
      src: c.src,
      dst: c.dst,
      write: c.write,
      safeguard: c.safeguard,
    })
  })
}
