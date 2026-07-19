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
import { FileType, PathSpec } from '../../../types.ts'
import { rekey } from '../../../utils/key_prefix.ts'
import type { CommandOpts, ProvisionFn } from '../../config.ts'
import { RegisteredCommand } from '../../config.ts'
import { BINARY_EXTENSIONS } from '../grep_helper.ts'
import { getExtension } from '../../resolve.ts'
import type { ReaddirOp, ResolveGlobOp, StatOp } from './adapter.ts'

// Cap on entries visited by a planning walk (grep -r): beyond it the
// estimate degrades to an UNKNOWN floor instead of walking forever.
export const MAX_PLAN_WALK = 1000

/**
 * Expand glob operands the way the executor would. Without a resolver
 * (or on any backend error) the original paths are returned, whose
 * pattern entries then stat-fail into UNKNOWN floors, which is the
 * pre-expansion behavior.
 */
function hasPattern(p: PathSpec): boolean {
  return p.pattern !== null && p.pattern !== ''
}

/**
 * Backend readdir/resolveGlob follow the executor's contract: specs
 * arrive in the resource view (virtual == mountPath). Planner specs
 * are full-virtual, so rebase before the call and restore after.
 */
function resourceView(p: PathSpec): PathSpec {
  if (p.virtual === p.mountPath) return p
  const mp = p.mountPath
  return new PathSpec({
    virtual: mp,
    directory: mp.slice(0, mp.lastIndexOf('/') + 1) || '/',
    pattern: p.pattern,
    resolved: p.resolved,
    resourcePath: p.resourcePath,
  })
}

function virtualPrefix(p: PathSpec): string {
  return p.virtual.slice(0, p.virtual.length - p.mountPath.length)
}

function restoreView(m: PathSpec, prefix: string): PathSpec {
  if (prefix === '') return m
  return new PathSpec({
    virtual: prefix + m.virtual,
    directory: prefix + m.directory,
    pattern: m.pattern,
    resolved: m.resolved,
    resourcePath: m.resourcePath,
  })
}

async function expandGlobs<A extends Accessor>(
  resolveGlob: ResolveGlobOp<A> | undefined,
  accessor: A,
  paths: PathSpec[],
  index: IndexCacheStore | undefined,
): Promise<PathSpec[]> {
  if (resolveGlob === undefined) return paths
  if (!paths.some(hasPattern)) return paths
  try {
    const out: PathSpec[] = []
    for (const p of paths) {
      if (!hasPattern(p)) {
        out.push(p)
        continue
      }
      const prefix = virtualPrefix(p)
      const matched = await resolveGlob(accessor, [resourceView(p)], index)
      for (const m of matched) out.push(restoreView(m, prefix))
    }
    return out
  } catch {
    return paths
  }
}

/**
 * Walk directories the way grep -r does, collecting file sizes.
 * Directories recurse; files skipped by the executor (columnar
 * BINARY_EXTENSIONS) are skipped here too so the estimate matches what
 * the run would read. Returns [sized files, complete]: complete is
 * false when the walk was capped or any entry failed to resolve, in
 * which case the totals are only floors.
 */
async function walkFiles<A extends Accessor>(
  readdir: ReaddirOp<A>,
  stat: StatOp<A>,
  accessor: A,
  roots: PathSpec[],
  index: IndexCacheStore | undefined,
): Promise<[[string, number][], boolean]> {
  const sized: [string, number][] = []
  let complete = true
  let visited = 0
  const queue: PathSpec[] = [...roots]
  while (queue.length > 0) {
    const p = queue.shift()
    if (p === undefined) break
    visited += 1
    if (visited > MAX_PLAN_WALK) return [sized, false]
    let s
    try {
      s = await stat(accessor, p, index)
    } catch {
      complete = false
      continue
    }
    if (s.type === FileType.DIRECTORY) {
      let entries
      try {
        entries = await readdir(accessor, resourceView(p), index)
      } catch {
        complete = false
        continue
      }
      const prefix = virtualPrefix(p)
      for (const e of entries) {
        const full = e.startsWith(prefix) && prefix !== '' ? e : prefix + e
        queue.push(PathSpec.fromStrPath(full, rekey(p.virtual, p.resourcePath, full)))
      }
      continue
    }
    if (BINARY_EXTENSIONS.has(getExtension(p.virtual) ?? '')) continue
    if (s.size === null) {
      complete = false
      continue
    }
    sized.push([p.virtual, s.size])
  }
  return [sized, complete]
}

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
export function makeFileReadProvision<A extends Accessor>(
  stat: StatOp<A>,
  resolveGlob?: ResolveGlobOp<A>,
): ProvisionFn<A> {
  return async (accessor: A, rawPaths: PathSpec[], _texts: string[], opts: CommandOpts) => {
    const command = opts.command ?? ''
    if (rawPaths.length === 0) {
      // Pathless invocations are stdin-driven (pipe stage, heredoc, or
      // an immediate missing-operand error): zero backend bytes.
      return new ProvisionResult({ command, precision: Precision.EXACT })
    }
    const paths = await expandGlobs(resolveGlob, accessor, rawPaths, opts.index ?? undefined)
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
export function makeHeadTailProvision<A extends Accessor>(
  stat: StatOp<A>,
  resolveGlob?: ResolveGlobOp<A>,
): ProvisionFn<A> {
  return async (accessor: A, rawPaths: PathSpec[], _texts: string[], opts: CommandOpts) => {
    const command = opts.command ?? ''
    if (rawPaths.length === 0) {
      // Pathless invocations are stdin-driven (pipe stage, heredoc, or
      // an immediate missing-operand error): zero backend bytes.
      return new ProvisionResult({ command, precision: Precision.EXACT })
    }
    const paths = await expandGlobs(resolveGlob, accessor, rawPaths, opts.index ?? undefined)
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
export function exactZeroProvision(
  _accessor: Accessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): ProvisionResult {
  // Chat/KB backends materialize their virtual tree from state the mount
  // already fetched, so metadata commands cost no backend I/O at all
  // (unlike metadataProvision, which charges one op per operand).
  return new ProvisionResult({
    command: opts.command ?? '',
    networkReadLow: 0,
    networkReadHigh: 0,
    readOps: 0,
    precision: Precision.EXACT,
  })
}

export async function indexHitReadProvision(
  _accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<ProvisionResult> {
  // The chat backends rebuild file bytes from API state, so a read costs
  // ops rather than sized transfers; operands the index has never seen
  // leave the estimate UNKNOWN.
  const command = opts.command ?? ''
  if (paths.length === 0) {
    return new ProvisionResult({ command, precision: Precision.UNKNOWN })
  }
  const index = opts.index ?? undefined
  let ops = 0
  if (index !== undefined) {
    for (const p of paths) {
      const lookup = await index.get(p.virtual)
      if (lookup.entry !== undefined && lookup.entry !== null) ops += 1
    }
  }
  return new ProvisionResult({
    command,
    networkReadLow: 0,
    networkReadHigh: 0,
    readOps: ops,
    precision: Precision.EXACT,
  })
}

export function makeJqProvision<A extends Accessor>(stat: StatOp<A>): ProvisionFn<A> {
  return async (accessor: A, paths: PathSpec[], texts: string[], opts: CommandOpts) => {
    const p = paths[0]
    const expr = texts[0]
    if (p === undefined) {
      // A pathless jq filters stdin (or errors without an expr): zero
      // backend bytes either way.
      return new ProvisionResult({ command: 'jq', precision: Precision.EXACT })
    }
    if (expr === undefined) {
      return new ProvisionResult({ command: 'jq', precision: Precision.UNKNOWN })
    }
    let fileStat
    try {
      fileStat = await stat(accessor, p, opts.index ?? undefined)
    } catch {
      return new ProvisionResult({ command: 'jq', precision: Precision.UNKNOWN })
    }
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
export function makeTransformProvision<A extends Accessor>(
  stat: StatOp<A>,
  resolveGlob?: ResolveGlobOp<A>,
): ProvisionFn<A> {
  const base = makeFileReadProvision(stat, resolveGlob)
  return async (accessor: A, paths: PathSpec[], texts: string[], opts: CommandOpts) => {
    const result = (await base(accessor, paths, texts, opts)) as ProvisionResult
    if (paths.length > 0) {
      // Output size (compression ratio, piece count) is unknowable.
      // A pathless transform filters stdin to stdout: exact zero.
      result.precision = Precision.UNKNOWN
    }
    return result
  }
}

/**
 * Provision for cp: bytes bracket 0 (server-side copy) to the total.
 * Reads the source sizes and reports both networkRead and networkWrite
 * as a 0..total range: a same-backend copy can be server-side (zero
 * client bytes) while a streamed copy moves the full byte count each way.
 */
export function makeCopyProvision<A extends Accessor>(
  stat: StatOp<A>,
  resolveGlob?: ResolveGlobOp<A>,
): ProvisionFn<A> {
  return async (accessor: A, rawPaths: PathSpec[], _texts: string[], opts: CommandOpts) => {
    const command = opts.command ?? ''
    const paths = await expandGlobs(resolveGlob, accessor, rawPaths, opts.index ?? undefined)
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

/**
 * Provision for sed: operands are read fully; -i writes back, so the
 * output keeps the read total as a floor with UNKNOWN.
 */
export function makeSedProvision<A extends Accessor>(stat: StatOp<A>): ProvisionFn<A> {
  const base = makeFileReadProvision(stat)
  return async (accessor: A, paths: PathSpec[], texts: string[], opts: CommandOpts) => {
    const result = (await base(accessor, paths, texts, opts)) as ProvisionResult
    if (opts.flags.i === true) result.precision = Precision.UNKNOWN
    return result
  }
}

/**
 * Provision for grep/rg: render the pattern then delegate to file_read.
 * With -r/-R and a readdir, directory operands are walked the way the
 * executor walks them (recursing subdirectories, skipping columnar
 * files), so a recursive search over an indexed tree prices exactly.
 */
export function makeSearchProvision<A extends Accessor>(
  stat: StatOp<A>,
  resolveGlob?: ResolveGlobOp<A>,
  readdir?: ReaddirOp<A>,
): ProvisionFn<A> {
  const base = makeFileReadProvision(stat, resolveGlob)
  return async (accessor: A, paths: PathSpec[], texts: string[], opts: CommandOpts) => {
    const rendered = [opts.command ?? '', ...texts, ...paths.map((p) => p.virtual)].join(' ')
    const recursive = opts.flags.r === true || opts.flags.R === true
    if (recursive && readdir !== undefined && paths.length > 0) {
      const roots = await expandGlobs(resolveGlob, accessor, paths, opts.index ?? undefined)
      const [sized, complete] = await walkFiles(
        readdir,
        stat,
        accessor,
        roots,
        opts.index ?? undefined,
      )
      const total = sized.reduce((acc, [, size]) => acc + size, 0)
      if (!complete || sized.length === 0) {
        return new ProvisionResult({
          command: rendered,
          networkReadLow: total,
          networkReadHigh: total,
          readOps: Math.max(sized.length, paths.length),
          precision: Precision.UNKNOWN,
        })
      }
      return new ProvisionResult({
        command: rendered,
        networkReadLow: total,
        networkReadHigh: total,
        readOps: sized.length,
        precision: Precision.EXACT,
      })
    }
    return base(accessor, paths, texts, { ...opts, command: rendered })
  }
}

const FILE_READ_COMMANDS: ReadonlySet<string> = new Set([
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
const HEAD_TAIL_COMMANDS: ReadonlySet<string> = new Set(['file', 'head', 'tail'])
const SEARCH_COMMANDS: ReadonlySet<string> = new Set(['grep', 'rg', 'zgrep'])
const METADATA_COMMANDS: ReadonlySet<string> = new Set([
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
const TRANSFORM_COMMANDS: ReadonlySet<string> = new Set([
  'csplit',
  'gunzip',
  'gzip',
  'patch',
  'split',
  'tar',
  'unzip',
  'zip',
])
const WRITE_METADATA_COMMANDS: ReadonlySet<string> = new Set([
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
  resolveGlob?: ResolveGlobOp<A>,
  readdir?: ReaddirOp<A>,
): ProvisionFn<A> | null {
  if (FILE_READ_COMMANDS.has(name)) return makeFileReadProvision(stat, resolveGlob)
  if (HEAD_TAIL_COMMANDS.has(name)) return makeHeadTailProvision(stat, resolveGlob)
  if (SEARCH_COMMANDS.has(name)) return makeSearchProvision(stat, resolveGlob, readdir)
  if (METADATA_COMMANDS.has(name)) return metadataProvision
  if (TRANSFORM_COMMANDS.has(name)) return makeTransformProvision(stat, resolveGlob)
  if (WRITE_METADATA_COMMANDS.has(name)) return writeMetadataProvision
  if (name === 'cp') return makeCopyProvision(stat, resolveGlob)
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
  resolveGlob?: ResolveGlobOp<A>,
  readdir?: ReaddirOp<A>,
): RegisteredCommand[] {
  return commands.map((c) => {
    if (c.filetype !== null || c.provisionFn !== null) return c
    const provision = defaultProvision(c.name, stat, resolveGlob, readdir)
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
