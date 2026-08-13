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
import { hiddenPathsActive, pathAllowed } from '../../../context/session_context.ts'
import { isMissingPath } from '../../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { respellRaw } from '../../../utils/path.ts'
import { lstripSlash, rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { formatRecords } from '../utils/output.ts'
import { humanSize } from '../utils/formatting.ts'
import type { LinkView, MountView, StatPath } from '../../../ops/types.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

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
  /** -S/--separate-dirs, directories exclude subdirectory sizes. */
  S: boolean
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
    S: fl.asBool('separate_dirs'),
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
 * A failed stat is not proof of absence, and du runs bound to one backend, so
 * its own stat cannot see two things that make a path a real directory: a
 * mount nested below it and a symlink below it are both namespace state, held
 * in another resource or in no resource at all. `statPath` is the channel that
 * knows, because it resolves through the dispatcher rather than one accessor,
 * and it is the same probe `find` classifies its start point with. Session
 * filtering rides along with it: a mount the session may not see contributes
 * no directory here, so absence stays the answer for it.
 *
 * `hasContent` is the last resort behind that, for a backend that never
 * materialises a directory entry for its own mount root (redis is one) while
 * the subtree below it is full.
 */
async function duOperands(
  paths: PathSpec[],
  cwd: string,
  resolveGlob: (targets: PathSpec[]) => Promise<PathSpec[]>,
  stat: (p: PathSpec) => Promise<unknown>,
  hasContent?: (p: PathSpec) => Promise<boolean>,
  mountPrefix?: string,
  links: LinkView | null = null,
  statPath: StatPath | null = null,
): Promise<{ present: PathSpec[]; missing: string[] }> {
  const targets = paths.length > 0 ? paths : [cwdSpec(cwd, mountPrefix)]
  const resolved = await resolveGlob(targets)
  const present: PathSpec[] = []
  const missing: string[] = []
  // An unmatched glob reaches GNU as the literal pattern, which it then
  // reports as unreadable.
  if (resolved.length === 0) missing.push(...targets.map((p) => p.rawPath))
  for (const path of resolved) {
    // A link has no backend inode, so it fails stat while still being a
    // perfectly readable operand.
    if (links?.statAt(path.virtual) != null) {
      present.push(path)
      continue
    }
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
    if (!stattable && statPath !== null && (await statPath(path.virtual)) !== null) {
      present.push(path)
      continue
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
 * Sum of leaves whose parent is the operand (GNU `-S` total).
 */
export function separateTotal(entries: [string, number][], root: string): number {
  const rootKey = norm(root)
  let total = 0
  for (const [leaf, size] of entries) {
    if (parentOf(norm(leaf)) === rootKey) total += size
  }
  return total
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
 * With `-S`/`--separate-dirs` a directory only counts files that sit
 * directly in it: a leaf still forces every ancestor directory to appear
 * (possibly at size 0), but only the immediate parent gets its bytes.
 * The operand's own line is not included; the caller renders it with the
 * operand as typed.
 */
export function rollup(
  entries: [string, number][],
  root: string,
  // `dirs`: paths that are directories even though no leaf points at
  // them. mirage cannot otherwise see an empty directory, so this is the
  // one case it can: an empty mount still gets GNU's `0` row.
  opts: {
    all: boolean
    maxDepth: number | null
    dirs?: readonly string[]
    separateDirs?: boolean
  },
): [string, number][] {
  const rootKey = norm(root)
  const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`
  const separateDirs = opts.separateDirs === true
  const sizes = new Map<string, number>()
  const files = new Map<string, number>()
  for (const [leaf, size] of entries) {
    const node = norm(leaf)
    if (node === rootKey || !node.startsWith(prefix)) continue
    files.set(node, size)
    let parent = parentOf(node)
    let immediate = true
    while (parent !== rootKey && parent.startsWith(prefix)) {
      if (separateDirs && !immediate) {
        // -S: only the directory a file sits in counts its bytes. The
        // ancestors still print, at 0 when they hold nothing but
        // directories.
        if (!sizes.has(parent)) sizes.set(parent, 0)
      } else {
        sizes.set(parent, (sizes.get(parent) ?? 0) + size)
      }
      immediate = false
      parent = parentOf(parent)
    }
  }

  // Set only when absent: a hinted directory that does hold leaves
  // already carries their total.
  for (const hinted of opts.dirs ?? []) {
    let node = norm(hinted)
    while (node !== rootKey && node.startsWith(prefix)) {
      if (!sizes.has(node)) sizes.set(node, 0)
      node = parentOf(node)
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
  for (const group of kids.values()) group.sort(compareCodePoints)

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

/**
 * Drop leaves that fall under a descendant mount's root.
 *
 * The parent backend's keys under a nested mount are shadowed: no read can
 * reach them, so no size may count them. GNU agrees (coreutils 9.7,
 * `du --apparent-size -B1` over a tmpfs mounted inside the operand): a file
 * covered by a mount appears nowhere and is in no total. What GNU
 * additionally folds into the parent's rows, the mounted filesystem's own
 * content, arrives here as the descendant's separately appended block
 * instead, so the parent's own report is GNU's `du -x`.
 */
function dropShadowed(entries: [string, number][], roots: string[]): [string, number][] {
  return entries.filter(([leaf]) => {
    const node = norm(leaf)
    return !roots.some((root) => node === root || node.startsWith(root + '/'))
  })
}

// Symlinks under an operand as du leaf entries.
//
// Links live in the namespace, so no backend du op or readdir walk
// reports them. Merging here, above that fork, is what keeps a backend
// with a native op and one without from disagreeing.
//
// Deliberate divergence: GNU sizes a symlink at 0 because it counts
// disk blocks and a short target is stored inside the inode. mirage
// counts bytes throughout (an object store has no block size), so a
// link counts as its target string's length, the same number `ls -l`
// prints for it.
function linkLeaves(links: LinkView | null, root: string): [string, number][] {
  if (links === null) return []
  return links.subtree(root).map(([path, st]): [string, number] => [path, st.size ?? 0])
}

async function duOne(
  path: PathSpec,
  computeSize: ComputeSize,
  computeEntries: ComputeEntries,
  fmt: (size: number) => string,
  flags: DuFlags,
  links: LinkView | null,
  mounts: MountView | null,
): Promise<[string[], number]> {
  const label = path.rawPath

  const linkRow = links?.statAt(path.virtual) ?? null
  if (linkRow !== null) {
    // GNU du does not follow a symlink operand without -L; the operand
    // is the link, and it accounts for the link alone.
    const size = linkRow.size ?? 0
    return [[`${fmt(size)}\t${label}`], size]
  }

  const roots = mounts?.descendants(path.virtual) ?? []
  let leaves = linkLeaves(links, path.virtual)
  if (roots.length > 0) leaves = dropShadowed(leaves, roots)
  const linkTotal = leaves.reduce((acc, [, size]) => acc + size, 0)

  if (flags.s && !flags.S && roots.length === 0 && !hiddenPathsActive()) {
    // The one-total fast path trusts the backend's own sum, which a
    // session hiding paths cannot: hidden leaves would be counted into
    // a total their names never justify, so that session takes the
    // entries walk below instead.
    const total = (await computeSize(path)) + linkTotal
    return [[`${fmt(total)}\t${label}`], total]
  }

  const [raw, rawTotal] = await computeEntries(path)
  let total = rawTotal + linkTotal
  if (raw.length === 0 && leaves.length === 0) {
    // A backend that can only produce a size degrades to one total; it
    // cannot enumerate, so shadowed keys cannot be excluded either.
    const fallback = await computeSize(path)
    return [[`${fmt(fallback)}\t${label}`], fallback]
  }

  let entries = toVirtual(raw, path).concat(leaves)
  const visible = entries.filter(([leaf]) => pathAllowed(leaf))
  if (visible.length !== entries.length) {
    // Same honesty rule as shadowed leaves: the total is the sum of
    // what the session may see, never the backend's own number.
    entries = visible
    total = entries.reduce((acc, [, size]) => acc + size, 0)
  }
  if (roots.length > 0) {
    // The backend's own total counted the shadowed leaves, so the
    // honest number is the sum of what survived.
    entries = dropShadowed(entries, roots)
    total = entries.reduce((acc, [, size]) => acc + size, 0)
  }
  const rootKey = norm(path.virtual)
  // A file operand walks to itself. GNU prints it once, with or without -a,
  // never as a leaf line plus a roll-up line. GNU scopes -S to directories, so
  // a file operand keeps its own size in both its row and the grand total.
  const first = entries[0]
  if (entries.length === 1 && first !== undefined && norm(first[0]) === rootKey) {
    return [[`${fmt(first[1])}\t${label}`], total]
  }
  // -S changes what the operand's own row counts, not what the operand
  // contributes to -c: GNU's grand total stays recursive (coreutils 9.7,
  // `du -bSc dir` prints `3 dir` then `6 total`).
  const own = flags.S ? separateTotal(entries, path.virtual) : total
  if (flags.s) {
    return [[`${fmt(own)}\t${label}`], total]
  }

  const rows = rollup(entries, path.virtual, {
    all: flags.a,
    maxDepth: flags.maxDepth,
    separateDirs: flags.S,
  })
  const shown = respellRaw(
    rows.map(([p]) => p),
    path.virtual,
    label,
  )
  const lines = rows.map(([, size], i) => `${fmt(size)}\t${shown[i] ?? ''}`)
  lines.push(`${fmt(own)}\t${label}`)
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
  // -L dereferences: the operand was already rewritten at dispatch, and
  // withholding the link table stops the links below it from being
  // counted as entries in their own right, which is what GNU does (it
  // follows each one and finds the target already accounted for). A
  // link pointing outside the operand's own subtree is undercounted;
  // GNU would traverse into it.
  const links = new FlagView(opts.flags, specOf('du')).asBool('L') ? null : (opts.ns?.links ?? null)
  const { present, missing } = await duOperands(
    paths,
    opts.cwd,
    resolveGlob,
    stat,
    (p) => duHasContent(computeEntries, p),
    opts.mountPrefix,
    links,
    opts.statPath ?? null,
  )
  return duGeneric(
    present,
    flags,
    computeSize,
    computeEntries,
    missing,
    truncated,
    links,
    opts.ns?.mounts ?? null,
  )
}

/**
 * Render `du` output for a list of operands.
 *
 * `computeEntries` reports mount-relative (path, size) pairs plus the total;
 * pass `undefined` on backends that can only produce a size, which makes both
 * `-a` and the per-directory lines degrade to one total. `missing` names the
 * operands that could not be read: GNU reports each and exits 1 but still
 * prints the rest. `truncated` is read after the walks to ask whether any of
 * them hit its entry cap. `mounts` marks the descendant boundaries: leaves
 * under one are shadowed and dropped from every row and total (see
 * `dropShadowed`).
 */
export async function duGeneric(
  paths: PathSpec[],
  flags: DuFlags,
  computeSize: ComputeSize,
  computeEntries: ComputeEntries,
  missing: string[] = [],
  truncated?: () => boolean,
  links: LinkView | null = null,
  mounts: MountView | null = null,
): Promise<DuOutput> {
  const fmt = (size: number): string => (flags.h ? humanSize(size) : String(size))

  const lines: string[] = []
  let grand = 0
  for (const root of paths) {
    const [block, total] = await duOne(root, computeSize, computeEntries, fmt, flags, links, mounts)
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
