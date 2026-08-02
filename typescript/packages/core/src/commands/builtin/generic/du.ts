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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { isMissingPath } from '../../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { respellRaw } from '../../../utils/path.ts'
import { lstripSlash, rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { formatRecords } from '../utils/output.ts'
import { humanSize } from '../utils/formatting.ts'

export type DuEntries = [entries: [string, number][], total: number]
export type ComputeSize = (p: PathSpec) => Promise<number>
export type ComputeEntries = (p: PathSpec) => Promise<DuEntries>

export const DEFAULT_MAX_DU_ENTRIES = 10000
const USAGE_HINT = "Try 'du --help' for more information."
const DEPTH_HEX = /^[+-]?0[xX][0-9a-fA-F]+$/
const DEPTH_OCT = /^[+-]?0[0-7]*$/
const DEPTH_DEC = /^[+-]?[1-9][0-9]*$/

/**
 * Read a `--max-depth` value the way GNU's `xstrtoul` does.
 *
 * That is C `strtoul` with base 0: a `0x` prefix is hexadecimal, a bare
 * leading `0` is octal (so `010` is 8 and `09` is invalid), anything else is
 * decimal. Surrounding whitespace is not allowed.
 */
export function parseDepth(text: string): number | null {
  const negative = text.startsWith('-')
  const body = text.replace(/^[+-]/, '')
  let value: number
  if (DEPTH_HEX.test(text)) value = Number.parseInt(body.slice(2), 16)
  else if (DEPTH_OCT.test(text)) value = Number.parseInt(body, 8)
  else if (DEPTH_DEC.test(text)) value = Number.parseInt(body, 10)
  else return null
  return negative && value !== 0 ? -value : value
}

/** The parsed `du` command line. */
export interface DuFlags {
  /** -s, one total per operand and no subtree lines. */
  s: boolean
  /** -a, list files as well as directories. */
  a: boolean
  /** -h, human-readable sizes. */
  h: boolean
  /** -c, append a grand total. */
  c: boolean
  /** --max-depth/-d, deepest level to print. */
  maxDepth: number | null
  /** A non-fatal diagnostic GNU prints before the output. */
  warning?: string
}

/** What `du` produced for one invocation. */
export interface DuOutput {
  stdout: Uint8Array
  /** Diagnostics: unreadable operands, then the truncation notice. */
  stderr: Uint8Array
  /**
   * 0, or 1 when an operand could not be read or a walk was cut short, as GNU
   * does for a tree it could not fully account for.
   */
  exitCode: number
}

const TRUNCATED_NOTE = 'du: walk stopped early: the reported sizes are incomplete'

/**
 * Validate a `du` command line the way GNU does, before any I/O.
 *
 * GNU parses `--max-depth` as each option is read, so a bad depth is reported
 * ahead of the mutually-exclusive checks that run once the whole line is
 * parsed. All three exit 1, du's usage-error code.
 */
export function parseDuFlags(opts: CommandOpts): DuFlags {
  const fl = new FlagView(opts.flags, specOf('du'))
  const s = fl.asBool('s')
  const a = fl.asBool('a')
  const raw = fl.asStr('max_depth')
  let maxDepth: number | null = null
  if (typeof raw === 'string') {
    maxDepth = parseDepth(raw)
    if (maxDepth === null) {
      throw new UsageError(`du: invalid maximum depth '${raw}'\n${USAGE_HINT}`, 1)
    }
  }
  if (s && a) {
    throw new UsageError(`du: cannot both summarize and show all entries\n${USAGE_HINT}`, 1)
  }
  let warning: string | undefined
  if (s && maxDepth !== null) {
    // GNU treats -s and --max-depth=0 as the same request, so it warns and
    // carries on; any other depth is a real conflict and exits 1.
    if (maxDepth !== 0) {
      throw new UsageError(
        `du: warning: summarizing conflicts with --max-depth=${String(maxDepth)}\n${USAGE_HINT}`,
        1,
      )
    }
    warning = 'du: warning: summarizing is the same as using --max-depth=0'
  }
  return {
    s,
    a,
    h: fl.asBool('h'),
    c: fl.asBool('c'),
    maxDepth,
    ...(warning === undefined ? {} : { warning }),
  }
}

/** The operand GNU `du` assumes when the line names none. */
function cwdSpec(cwd: string, mountPrefix?: string): PathSpec {
  const dir = cwd || '/'
  // The cwd is a virtual path, so under a non-root mount its backend key is
  // the cwd with the mount prefix removed: from /ram the backend must be
  // asked for its own root, not for a 'ram' entry inside itself.
  return new PathSpec({
    resourcePath: mountPrefix === undefined ? stripSlash(dir) : mountKey(dir, mountPrefix),
    virtual: dir,
    directory: dir,
    resolved: false,
  })
}

/**
 * Whether an operand holds anything, for the unstattable case.
 */
async function duHasContent(computeEntries: ComputeEntries, path: PathSpec): Promise<boolean> {
  try {
    const [entries] = await computeEntries(path)
    return entries.length > 0
  } catch {
    // This runs only after stat already failed, to tell an implicit
    // directory from an absent path. Backends raise their own error types
    // here (Graph 404, SFTP no-such-file), and every one of them means the
    // same thing: nothing to measure. Surfacing it would replace GNU's
    // "cannot access" line with a driver error.
    return false
  }
}

/**
 * Split the operands into the ones du can read and the ones it cannot.
 *
 * GNU names every operand it fails to stat, keeps going with the rest, and
 * exits 1. With no operand at all it measures the working directory.
 *
 * A failed stat is not proof of absence. Several backends never materialise a
 * directory entry for the mount root (redis is one), so `stat` throws there
 * even though the subtree is full. `hasContent` is the second opinion: only an
 * operand that neither stats nor holds anything is reported missing.
 */
async function duOperands(
  paths: PathSpec[],
  cwd: string,
  resolveGlob: (targets: PathSpec[]) => Promise<PathSpec[]>,
  stat: (p: PathSpec) => Promise<unknown>,
  hasContent?: (p: PathSpec) => Promise<boolean>,
  mountPrefix?: string,
): Promise<{ present: PathSpec[]; missing: string[] }> {
  const targets = paths.length > 0 ? paths : [cwdSpec(cwd, mountPrefix)]
  const resolved = await resolveGlob(targets)
  const present: PathSpec[] = []
  const missing: string[] = []
  // An unmatched glob reaches GNU as the literal pattern, which it then
  // reports as unreadable.
  if (resolved.length === 0) missing.push(...targets.map((p) => p.rawPath))
  for (const path of resolved) {
    // A missing path is the diagnostic, not an error to propagate. Any
    // other backend failure (403, a driver fault) is real and must surface
    // rather than being renamed "No such file or directory".
    let stattable = true
    try {
      await stat(path)
    } catch (err) {
      if (!isMissingPath(err)) throw err
      stattable = false
    }
    if (!stattable && !(hasContent !== undefined && (await hasContent(path)))) {
      missing.push(path.rawPath)
      continue
    }
    present.push(path)
  }
  return { present, missing }
}

function norm(path: string): string {
  return rstripSlash(path) || '/'
}

function parentOf(path: string): string {
  const cut = norm(path).lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : '/'
}

function depthOf(entryPath: string, basePath: string): number {
  const base = rstripSlash(basePath)
  const rel = rstripSlash(entryPath).slice(base.length)
  if (!rel) return 0
  return (stripSlash(rel).match(/\//g) ?? []).length + 1
}

/**
 * Lift mount-relative walk entries onto absolute virtual paths.
 *
 * Backends walk their own key space and report mount-relative paths, so two
 * mounts that both hold `notes.txt` would otherwise render the same line. The
 * mount prefix is recovered from the operand the same way `find` and `grep -r`
 * recover it.
 */
export function toVirtual(entries: [string, number][], path: PathSpec): [string, number][] {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  if (!prefix) return [...entries]
  return entries.map(([entry, size]) => [`${prefix}/${lstripSlash(entry)}`, size])
}

/**
 * Derive GNU's per-directory lines from a flat list of leaf files.
 *
 * Backends report only files, but GNU `du` prints a line per directory
 * carrying its recursive total (and, under `-a`, a line per file too). Every
 * directory between the operand and a leaf therefore accumulates that leaf's
 * size, and the result is emitted post-order: children before their parent,
 * siblings sorted by name. GNU walks in readdir order, which is unspecified,
 * so sorting is a deterministic choice within the same shape.
 *
 * The operand's own line is not included; the caller renders it with the
 * operand as typed.
 */
export function rollup(
  entries: [string, number][],
  root: string,
  opts: { all: boolean; maxDepth: number | null },
): [string, number][] {
  const rootKey = norm(root)
  const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`
  const sizes = new Map<string, number>()
  const files = new Map<string, number>()
  for (const [leaf, size] of entries) {
    const node = norm(leaf)
    if (node === rootKey || !node.startsWith(prefix)) continue
    files.set(node, size)
    let parent = parentOf(node)
    while (parent !== rootKey && parent.startsWith(prefix)) {
      sizes.set(parent, (sizes.get(parent) ?? 0) + size)
      parent = parentOf(parent)
    }
  }

  // Keyed backends (S3, GridFS) carry a zero-byte marker object for a
  // directory, which arrives here as a leaf. Under -a it must not replace
  // that directory's computed total, so sums win on a clash.
  const nodes = opts.all ? new Map(files) : new Map<string, number>()
  for (const [node, size] of sizes) nodes.set(node, size)
  const kids = new Map<string, string[]>()
  for (const node of nodes.keys()) {
    const parent = parentOf(node)
    const group = kids.get(parent)
    if (group === undefined) kids.set(parent, [node])
    else group.push(node)
  }
  for (const group of kids.values()) group.sort()

  const order: [string, number][] = []
  const stack: [string, boolean][] = [[rootKey, false]]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    const [node, expanded] = frame
    if (expanded) {
      const deep = opts.maxDepth !== null && depthOf(node, rootKey) > opts.maxDepth
      if (node !== rootKey && !deep) order.push([node, nodes.get(node) ?? 0])
      continue
    }
    stack.push([node, true])
    const group = kids.get(node) ?? []
    for (let i = group.length - 1; i >= 0; i--) stack.push([group[i] ?? '', false])
  }
  return order
}

async function duOne(
  path: PathSpec,
  computeSize: ComputeSize,
  computeEntries: ComputeEntries,
  fmt: (size: number) => string,
  flags: DuFlags,
): Promise<[string[], number]> {
  const label = path.rawPath

  if (flags.s) {
    const total = await computeSize(path)
    return [[`${fmt(total)}\t${label}`], total]
  }

  const [raw, total] = await computeEntries(path)
  if (raw.length === 0) {
    const fallback = await computeSize(path)
    return [[`${fmt(fallback)}\t${label}`], fallback]
  }

  const entries = toVirtual(raw, path)
  const rootKey = norm(path.virtual)
  // A file operand walks to itself. GNU prints it once, with or without -a,
  // never as a leaf line plus a roll-up line.
  const first = entries[0]
  if (entries.length === 1 && first !== undefined && norm(first[0]) === rootKey) {
    return [[`${fmt(first[1])}\t${label}`], total]
  }

  const rows = rollup(entries, path.virtual, { all: flags.a, maxDepth: flags.maxDepth })
  const shown = respellRaw(
    rows.map(([p]) => p),
    path.virtual,
    label,
  )
  const lines = rows.map(([, size], i) => `${fmt(size)}\t${shown[i] ?? ''}`)
  lines.push(`${fmt(total)}\t${label}`)
  return [lines, total]
}

/**
 * Run one whole `du` invocation, from raw flags to rendered bytes.
 *
 * Every caller needs the same three steps in the same order: validate the
 * flags before touching I/O, split the operands into readable and unreadable,
 * then render. Keeping them here means a backend wrapper is wiring only, and
 * the three steps cannot drift apart per backend.
 */
export async function runDu(
  paths: PathSpec[],
  opts: CommandOpts,
  resolveGlob: (targets: PathSpec[]) => Promise<PathSpec[]>,
  stat: (p: PathSpec) => Promise<unknown>,
  computeSize: ComputeSize,
  computeEntries: ComputeEntries,
  truncated?: () => boolean,
): Promise<DuOutput> {
  const flags = parseDuFlags(opts)
  const { present, missing } = await duOperands(
    paths,
    opts.cwd,
    resolveGlob,
    stat,
    (p) => duHasContent(computeEntries, p),
    opts.mountPrefix,
  )
  return duGeneric(present, flags, computeSize, computeEntries, missing, truncated)
}

/**
 * Render `du` output for a list of operands.
 *
 * `computeEntries` reports mount-relative (path, size) pairs plus the total;
 * pass `undefined` on backends that can only produce a size, which makes both
 * `-a` and the per-directory lines degrade to one total. `missing` names the
 * operands that could not be read: GNU reports each and exits 1 but still
 * prints the rest. `truncated` is read after the walks to ask whether any of
 * them hit its entry cap.
 */
export async function duGeneric(
  paths: PathSpec[],
  flags: DuFlags,
  computeSize: ComputeSize,
  computeEntries: ComputeEntries,
  missing: string[] = [],
  truncated?: () => boolean,
): Promise<DuOutput> {
  const fmt = (size: number): string => (flags.h ? humanSize(size) : String(size))

  const lines: string[] = []
  let grand = 0
  for (const root of paths) {
    const [block, total] = await duOne(root, computeSize, computeEntries, fmt, flags)
    lines.push(...block)
    grand += total
  }
  // GNU still prints the grand total when every operand failed ("0 total"), so
  // this stays outside the loop guard.
  if (flags.c) lines.push(`${fmt(grand)}\ttotal`)

  const notes = flags.warning === undefined ? [] : [flags.warning]
  notes.push(...missing.map((raw) => `du: cannot access '${raw}': No such file or directory`))
  let exitCode = missing.length > 0 ? 1 : 0
  if (truncated?.() === true) {
    notes.push(TRUNCATED_NOTE)
    exitCode = 1
  }
  const stderr =
    notes.length > 0 ? new TextEncoder().encode(`${notes.join('\n')}\n`) : new Uint8Array(0)
  return { stdout: formatRecords(lines), stderr, exitCode }
}
