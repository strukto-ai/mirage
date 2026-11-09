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
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { asyncChain } from '../../../io/stream.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import {
  LINK_TARGET_KEY,
  FileStat,
  FileType,
  LineFacts,
  PathSpec,
  type ReaddirFn,
  type ReadStreamFn,
  type StatFn,
} from '../../../types.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { enoent, isFsError, isMissError, isWalkError } from '../../../errors/fs.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import type { LinkResolve, MountView } from '../../../view/types.ts'
import { decodeText, encodeText, utf8Locale } from '../../../shell/bytes.ts'
import { charWidth } from '../../../io/async_line_iterator.ts'
import { groupName, identityOf, ownerName, type Identity } from '../utils/identity.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { formatRecords } from '../utils/output.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { linksOf, mountsOf } from '../utils/links.ts'
import { vfsReaddirPath, vfsStatPath } from '../utils/paths.ts'
import { WalkBudget } from '../utils/tree.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { AnyTailMatcher } from '../../../rs/glob.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { lsModeString, styledTime, timeOf } from '../utils/formatting.ts'
import { sortByVersion } from './ls.ts'
import { isoTimestamp } from '../../../utils/dates.ts'
import { contentSize, posixMode } from '../../../utils/stat_view.ts'

const UNOPENABLE_MARK = '  [error opening dir]'
const RECURSIVE_MARK = '  [recursive, not followed]'
const UNKNOWN_INODE = '?'
// The escapes a name's control characters take in the C locale.
const C_ESCAPES: ReadonlyMap<number, string> = new Map([
  [7, 'a'],
  [8, 'b'],
  [9, 't'],
  [10, 'n'],
  [11, 'v'],
  [12, 'f'],
  [13, 'r'],
])
const SI_UNITS = 'kMGTPE'
// Where --si stops writing a tenth, pinned on tree 2.2.1.
const SI_TENTHS_BELOW = 9.948
// The lines a drawing holds before it writes them, whatever comes next.
const HELD_LINES = 1024
const ENC = new TextEncoder()
const DEC = new TextDecoder()

// tree's ASCII (C-locale) drawing set, matching `tree` in the battery's
// docker oracle; the vertical/indent continuations are 4 columns wide.
const BRANCH = '|-- '
const LAST = '`-- '
const VERTICAL = '|   '
const INDENT = '    '
// The drawing set of a UTF-8 locale.
const UTF8_BRANCH = '\u251c\u2500\u2500 '
const UTF8_LAST = '\u2514\u2500\u2500 '
const UTF8_VERTICAL = '\u2502   '
// The same four as -A draws them, in the terminal's line-drawing set.
const ANSI_BRANCH = 'tqq '
const ANSI_LAST = 'mqq '
const ANSI_VERTICAL = 'x   '
const ANSI_OPEN = '\x1b(0'
const ANSI_CLOSE = '\x1b(B'

export type TreeSort = 'name' | 'version' | 'size' | 'mtime' | 'ctime' | 'none'

// The orders --sort names, and the one each shorthand asks for.
const SORTS: readonly TreeSort[] = ['name', 'version', 'size', 'mtime', 'ctime', 'none']
const SHORTHANDS: Readonly<Record<string, TreeSort>> = { t: 'mtime', v: 'version', U: 'none' }

/** tree's line, parsed: what the walk draws, in what order, and what each
 * line shows. Mirrors Python's TreeFlags. */
export interface TreeFlags {
  readonly maxDepth: number | null
  readonly showHidden: boolean
  readonly ignorePattern: string | null
  readonly dirsOnly: boolean
  readonly matchPattern: string | null
  readonly oneFileSystem: boolean
  readonly fullPath: boolean
  readonly noIndent: boolean
  readonly sizes: boolean
  readonly dates: boolean
  readonly perms: boolean
  readonly classify: boolean
  readonly sort: TreeSort
  readonly reverse: boolean
  readonly dirsFirst: boolean
  readonly noReport: boolean
  readonly du: boolean
  readonly prune: boolean
  readonly gitignore: boolean
  readonly fileLimit: number | null
  readonly json: boolean
  readonly follow: boolean
  readonly ansiLines: boolean
  readonly quote: boolean
  readonly rawNames: boolean
  readonly question: boolean
  readonly owner: boolean
  readonly group: boolean
  readonly changeTime: boolean
  readonly si: boolean
  readonly timeFormat: string | null
  readonly filesFirst: boolean
  readonly ignoreCase: boolean
  readonly matchDirs: boolean
  readonly inodes: boolean
  readonly output: PathSpec | null
  readonly utf8: boolean
  readonly identity: Identity | null
}

/**
 * tree's options, -L and --filelimit read by mirage-rs before any operand is
 * resolved; -t, -v, -U and --sort each set the order, the last one typed
 * winning, and -c turns a modification time order into a change time one.
 * The flags, or tree's refusal of a level or an order. Mirrors Python's
 * `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>): TreeFlags | IOResult {
  const fl = new FlagView(bag, specOf('tree'))
  let values
  try {
    values = scan('tree', [...fl.texts('L'), ...fl.texts('filelimit')])
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const level = values.L
  const limit = values.filelimit
  if (level !== null && typeof level !== 'number') {
    throw new Error(`tree: mirage-rs read -L as ${JSON.stringify(level)}`)
  }
  if (limit !== null && typeof limit !== 'number') {
    throw new Error(`tree: mirage-rs read --filelimit as ${JSON.stringify(limit)}`)
  }
  let sort: TreeSort = 'name'
  for (const [name, value] of fl.occurrences('t', 'v', 'U', 'sort', 'c')) {
    if (name === 'c') {
      if (value === true && sort === 'mtime') sort = 'ctime'
      continue
    }
    const shorthand = Object.hasOwn(SHORTHANDS, name) ? SHORTHANDS[name] : undefined
    if (shorthand !== undefined) {
      if (value === true) sort = shorthand
      continue
    }
    const typed = String(value)
    const known = SORTS.find((order) => order === typed)
    if (known === undefined)
      return new IOResult({
        exitCode: 1,
        stdout: ENC.encode(`${SORTS.join(',')}\n`),
        stderr: ENC.encode(`tree: Sort type '${typed}' not valid, should be one of: `),
      })
    sort = known
  }
  const timeFormat = fl.asStr('timefmt') ?? null
  const grouped = fl.typedOrder('dirsfirst', 'filesfirst')
  return {
    maxDepth: level,
    showHidden: fl.asBool('a'),
    ignorePattern: fl.asStr('args_I') ?? null,
    dirsOnly: fl.asBool('d'),
    matchPattern: fl.asStr('P') ?? null,
    oneFileSystem: fl.asBool('x'),
    fullPath: fl.asBool('f'),
    noIndent: fl.asBool('i'),
    sizes: fl.asBool('s'),
    dates: fl.asBool('D') || timeFormat !== null,
    perms: fl.asBool('p'),
    classify: fl.asBool('F'),
    sort,
    reverse: fl.asBool('r'),
    dirsFirst: grouped[grouped.length - 1] === 'dirsfirst',
    filesFirst: grouped[grouped.length - 1] === 'filesfirst',
    noReport: fl.asBool('noreport'),
    du: fl.asBool('du'),
    prune: fl.asBool('prune'),
    gitignore: fl.asBool('gitignore'),
    fileLimit: limit,
    json: fl.asBool('J'),
    follow: fl.asBool('args_l'),
    ansiLines: fl.asBool('A'),
    quote: fl.asBool('Q'),
    rawNames: fl.asBool('N'),
    question: fl.asBool('q'),
    owner: fl.asBool('u'),
    group: fl.asBool('g'),
    changeTime: fl.asBool('c'),
    si: fl.asBool('si'),
    timeFormat,
    ignoreCase: fl.asBool('ignore_case'),
    matchDirs: fl.asBool('matchdirs'),
    inodes: fl.asBool('inodes'),
    output: fl.asPath('o') ?? null,
    utf8: false,
    identity: null,
  }
}

// One drawn entry: its row, what it counts as, and below it, for a directory
// the walk opened, the entries drawn under it. Mirrors Python's `_Node`.
interface TreeNode {
  readonly spec: PathSpec
  readonly stat: FileStat
  isDir: boolean
  readonly leads: FileStat | null
  children: TreeNode[] | null
  note: string
  unopened: number
  du: number
  missing: boolean
}

// One .gitignore line: the pattern, where it was read, and whether it
// re-includes, names only directories, or is anchored to its file's
// directory. Mirrors Python's `_Ignore`.
interface Ignore {
  readonly pattern: string
  readonly base: string
  readonly negated: boolean
  readonly directory: boolean
  readonly anchored: boolean
}

interface TreeOpts {
  readonly flags: TreeFlags
  // Where the boundaries are, and the dispatcher-backed pair that reads
  // past one. Unlike find and du, tree's output is a single document
  // (one root line, one drawing, one count), so a per-mount run cannot
  // be concatenated: it would print two of each. The boundary is crossed
  // here instead, the way real tree crosses one.
  readonly mounts: MountView | null
  readonly crossReaddir: ((p: PathSpec) => Promise<string[]>) | null
  readonly crossStat: ((p: PathSpec) => Promise<FileStat>) | null
  // What a drawn link leads to, from the namespace's symlink facts.
  readonly targetStat: ((path: string) => Promise<FileStat | null>) | null
  // The mount's reader, for the .gitignore files --gitignore reads.
  readonly read: ReadStreamFn | null
  // The entries this operand's walk may still list; a directory past it is
  // drawn but not opened.
  readonly budget?: WalkBudget
  // The operand this walk draws from, for --matchdirs.
  readonly root?: string
  // Where a link really leads, and the directories -l has been in.
  readonly resolve: LinkResolve | null
  readonly seen: Set<string>
}

// A .gitignore's patterns, in order: blank lines and `#` comments are
// skipped, trailing blanks dropped, `!` re-includes, a trailing `/` names
// only a directory, and any other `/` anchors the pattern to `base`.
// Mirrors Python's `_gitignore_lines`.
function gitignoreLines(text: string, base: string): Ignore[] {
  const rules: Ignore[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/ +$/, '')
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)
    if (line.startsWith('\\')) line = line.slice(1)
    const directory = line.endsWith('/')
    line = line.replace(/\/+$/, '')
    if (line === '') continue
    const anchored = line.includes('/')
    rules.push({ pattern: line.replace(/^\/+/, ''), base, negated, directory, anchored })
  }
  return rules
}

// A mount root's row. The mount table already says it is a directory, and the
// backend serving it may not stat its own root (an empty mount, or a prefix
// store with no marker object), so only -p and -D, which print from the row,
// ask for the real one. Mirrors Python's `_mount_row`.
async function mountRow(
  flags: TreeFlags,
  crossStat: ((p: PathSpec) => Promise<FileStat>) | null,
  spec: PathSpec,
  name: string,
): Promise<FileStat> {
  const row = new FileStat({ name, type: FileType.DIRECTORY })
  if (crossStat === null || !(flags.perms || flags.dates)) return row
  try {
    return (await crossStat(spec)).with({ name, type: FileType.DIRECTORY })
  } catch (err) {
    if (!isWalkError(err)) throw err
    console.debug(`tree: no row for mount ${spec.virtual}: ${String(err)}`)
    return row
  }
}

// Whether a path fits a pattern, a `**` for any run of segments and, last in
// the pattern, at least one. Only the latest `**` is ever retried, since it
// can take whatever an earlier one would have, so the work stays the path's
// length times the pattern's, however many `**` a .gitignore writes. Mirrors
// Python's `_segments_match`.
export function segmentsMatch(parts: readonly string[], pattern: readonly string[]): boolean {
  let at = 0
  let want = 0
  let resume = 0
  let star = -1
  while (at < parts.length) {
    const segment = pattern[want]
    if (segment === '**') {
      star = want
      resume = at
      want += 1
    } else if (segment !== undefined && fnmatch(parts[at] ?? '', segment)) {
      at += 1
      want += 1
    } else if (star >= 0) {
      resume += 1
      at = resume
      want = star + 1
    } else {
      return false
    }
  }
  return want === pattern.length
}

// Whether the last .gitignore pattern that matches an entry leaves it out.
// Mirrors Python's `_ignored`.
// One matcher over the patterns a name alone decides, so an entry none of them
// matches costs one call however many there are. Mirrors Python's
// `_name_matcher`, one for each list of rules.
const nameMatchers = new WeakMap<readonly Ignore[], AnyTailMatcher | null>()

/** Whether a name fits -P or -I, `|` parting alternatives. */
function hit(flags: TreeFlags, pattern: string, name: string): boolean {
  const text = flags.ignoreCase ? name.toLowerCase() : name
  const typed = flags.ignoreCase ? pattern.toLowerCase() : pattern
  return typed.split('|').some((part) => fnmatch(text, part))
}

/** Whether --matchdirs passes a directory's own files: its path under the
 * operand fits the pattern, `*` stopping at each `/`. */
function letsFilesThrough(flags: TreeFlags, root: string, directory: string): boolean {
  if (!flags.matchDirs || flags.matchPattern === null) return false
  const base = rstripSlash(root)
  if (directory === root || !directory.startsWith(`${base}/`)) return false
  const relative = directory.slice(base.length + 1)
  const text = flags.ignoreCase ? relative.toLowerCase() : relative
  const typed = flags.ignoreCase ? flags.matchPattern.toLowerCase() : flags.matchPattern
  const parts = text.split('/')
  return typed.split('|').some((part) => segmentsMatch(parts, part.replace(/\/+$/, '').split('/')))
}

function nameMatcher(rules: readonly Ignore[]): AnyTailMatcher | null {
  let matcher = nameMatchers.get(rules)
  if (matcher === undefined) {
    const patterns = rules.filter((rule) => !rule.anchored).map((rule) => rule.pattern)
    matcher = patterns.length > 0 ? new AnyTailMatcher(patterns) : null
    nameMatchers.set(rules, matcher)
  }
  return matcher
}

function ignored(
  rules: readonly Ignore[],
  names: AnyTailMatcher | null,
  virtual: string,
  isDir: boolean,
): boolean {
  let out = false
  const name = virtual.slice(virtual.lastIndexOf('/') + 1)
  const named = names?.matches(name) === true
  let base: string | null = null
  let parts: string[] = []
  for (const rule of rules) {
    if (rule.directory && !isDir) continue
    let hit: boolean
    if (!rule.anchored) hit = named && fnmatch(name, rule.pattern)
    else {
      if (rule.base !== base) {
        base = rule.base
        const root = rstripSlash(base)
        parts = (virtual.startsWith(`${root}/`) ? virtual.slice(root.length + 1) : virtual).split(
          '/',
        )
      }
      hit = segmentsMatch(parts, rule.pattern.split('/'))
    }
    if (hit) out = !rule.negated
  }
  return out
}

// A directory's entries in the order --sort (-t, -v, -U) asks for, reversed
// under -r, directories first under --dirsfirst. Mirrors Python's `_sorted`.
async function sorted(flags: TreeFlags, nodes: readonly TreeNode[]): Promise<TreeNode[]> {
  const when = (node: TreeNode): number => {
    const changed = flags.sort === 'ctime' ? node.stat.ctime : null
    return isoTimestamp(changed ?? node.stat.modified) ?? 0
  }
  const compare = (a: TreeNode, b: TreeNode): number => {
    if (flags.sort === 'size') {
      const by = contentSize(b.stat) - contentSize(a.stat)
      if (by !== 0) return by
    } else if (flags.sort === 'mtime' || flags.sort === 'ctime') {
      const by = when(a) - when(b)
      if (by !== 0) return by
    }
    return compareCodePoints(a.stat.name, b.stat.name)
  }
  let order: TreeNode[]
  if (flags.sort === 'version') {
    const places = await sortByVersion(nodes.map((n) => n.stat.name))
    order = places.flatMap((i) => {
      const node = nodes[i]
      return node === undefined ? [] : [node]
    })
  } else if (flags.sort === 'none') {
    order = [...nodes]
  } else {
    order = [...nodes].sort(compare)
  }
  if (flags.reverse && flags.sort !== 'none') order.reverse()
  if (flags.dirsFirst || flags.filesFirst) {
    order = [
      ...order.filter((n) => n.isDir === flags.dirsFirst),
      ...order.filter((n) => n.isDir !== flags.dirsFirst),
    ]
  }
  return order
}

// The patterns a directory's own .gitignore adds, none when it has none or
// it cannot be read. Mirrors Python's `_gitignore`.
async function gitignore(
  read: ReadStreamFn | null,
  directory: PathSpec,
  names: readonly string[],
): Promise<Ignore[]> {
  if (read === null || !names.some((name) => name.endsWith('/.gitignore'))) return []
  const virtual = `${rstripSlash(directory.virtual)}/.gitignore`
  const path = new PathSpec({
    virtual,
    directory: virtual,
    resolved: false,
    vfsPath: stripSlash(virtual),
  })
  let text: string
  try {
    text = DEC.decode(await materialize(read(path)))
  } catch (err) {
    if (!isWalkError(err)) throw err
    console.debug(`tree: cannot read ${virtual}: ${String(err)}`)
    return []
  }
  return gitignoreLines(text, directory.virtual)
}

// The mount roots mounted directly on this directory. A mount point need
// not exist in the parent backend at all, and when it does the parent
// lists a directory whose contents belong to somebody else. Either way
// the name has to come from the mount table, as `ls` injects it.
//
// Session-filtered, because a crossing entry is drawn from the mount
// table alone: its row is synthesized as a directory without asking any
// backend, so the dispatcher never gets the chance to refuse it and an
// hidden mount's name would reach the drawing. `ls` filters the same
// fact through `childMountNames`. `tree` names the boundary rather than
// avoiding it, so it reads the visible list; `du` reads the other one
// from the same view, because there a hidden mount still shadows the
// parent's keys and its prefix has to stay.
function childMounts(mounts: MountView | null, directory: string): string[] {
  if (mounts === null) return []
  const base = rstripSlash(directory) || '/'
  return mounts.visibleDescendants(directory).filter((root) => {
    const parent = root.slice(0, root.lastIndexOf('/')) || '/'
    return parent === base
  })
}

// One directory's drawn entries, the note its own line carries, and how many
// directories in its subtree (itself included) could not be opened. A link
// is drawn as `name -> target` and never walked; one leading to a directory
// counts, and filters, as a directory, and one whose target cannot be
// statted as a file, as a dangling one does (tree 2.2.1). A directory the
// walk could not open (a rule refused it below the operand) has no entries
// and counts itself, so the caller marks its own line the way tree does and
// the run exits 2. A directory past the budget is drawn but not opened, and
// one holding more entries than --filelimit is drawn with a note instead.
// Mirrors Python's `_walk_tree`.
// One opened directory: its entries in drawing order (null when it has none
// to draw, `note` then saying why), which of them are mounts it crosses into,
// and the ignore rules its subtree inherits. Mirrors Python's `_Listing`.
interface Listing {
  readonly nodes: TreeNode[] | null
  readonly note: string
  readonly unopened: number
  readonly crossed: ReadonlySet<TreeNode>
  readonly rules: readonly Ignore[]
}

// One operand's drawing in progress: lines not yet written and what has been
// counted so far. Mirrors Python's `_Drawing`.
interface Drawing {
  lines: string[]
  dirs: number
  files: number
  unopened: number
}

// One directory's own entries, in the order they are drawn. Mirrors Python's
// `_open_dir`.
async function openDir(
  readdir: ReaddirFn<[p: PathSpec, nofollow?: boolean, limit?: number]>,
  stat: StatFn,
  path: PathSpec,
  treeOpts: TreeOpts,
  inherited: readonly Ignore[],
): Promise<Listing> {
  const flags = treeOpts.flags
  // The mount table is read before the backend, not merged after it. A
  // directory that exists only because mounts sit under it (`/repos` when
  // `/repos/alpha` is mounted) has no backend to list it, so the readdir
  // throws and a merge below it never runs: `tree` reported the one path
  // whose children it could name for certain as unopenable.
  const nested = childMounts(treeOpts.mounts, path.virtual)
  const limit = treeOpts.budget?.listingLimit(path.virtual) ?? null
  let entries: string[]
  try {
    entries = await (limit === null ? readdir(path) : readdir(path, false, limit))
  } catch (err) {
    if (!isWalkError(err)) throw err
    // An absence only. A directory the backend refused (EACCES, ENOTSUP) is
    // there and holds data, so it stays a warning and an unopened row even
    // when mounts sit under it; swallowing that to draw the children would
    // report a readable tree that is not.
    if (nested.length === 0 || !isMissError(err)) {
      return { nodes: null, note: UNOPENABLE_MARK, unopened: 1, crossed: new Set(), rules: [] }
    }
    entries = []
  }
  if (nested.length > 0) entries = [...new Set([...entries, ...nested])]
  if (flags.sort !== 'none') entries.sort(compareCodePoints)
  const budget = treeOpts.budget
  if (budget !== undefined) entries = entries.filter(() => budget.spend(path.virtual))
  const found = flags.gitignore ? await gitignore(treeOpts.read, path, entries) : []
  const rules = found.length > 0 ? [...inherited, ...found] : inherited
  const names = nameMatcher(rules)
  const allFiles = letsFilesThrough(flags, treeOpts.root ?? '', path.virtual)
  const kept: { node: TreeNode; crossing: boolean }[] = []
  for (const entry of entries) {
    const childPath = rstripSlash(entry)
    const name = childPath.slice(childPath.lastIndexOf('/') + 1)
    const sub = new PathSpec({
      virtual: childPath,
      directory: childPath,
      resolved: false,
      vfsPath: stripSlash(childPath),
      rawPath: `${rstripSlash(path.rawPath)}/${name}`,
    })
    const crossing = nested.includes(childPath) && treeOpts.crossReaddir !== null
    let s: FileStat
    if (crossing) {
      s = await mountRow(flags, treeOpts.crossStat, sub, name)
    } else {
      try {
        s = await stat(sub)
      } catch (err) {
        if (!isWalkError(err)) throw err
        continue
      }
    }
    if (!flags.showHidden && s.name.startsWith('.')) continue
    if (flags.ignorePattern !== null && hit(flags, flags.ignorePattern, s.name)) continue
    let isDir = s.type === FileType.DIRECTORY
    let leads: FileStat | null = null
    if (s.type === FileType.SYMLINK && treeOpts.targetStat !== null) {
      // One whose target cannot be statted is drawn as a file, as a
      // dangling one is (tree 2.2.1).
      leads = await treeOpts.targetStat(childPath).catch((err: unknown) => {
        if (!isWalkError(err)) throw err
        console.debug(`tree: cannot stat through ${childPath}: ${String(err)}`)
        return null
      })
      isDir = leads !== null && leads.type === FileType.DIRECTORY
    }
    if (flags.dirsOnly && !isDir) continue
    // -P spares only a real directory, a link to one included in its test
    // (tree 2.2.1).
    if (
      flags.matchPattern !== null &&
      s.type !== FileType.DIRECTORY &&
      !allFiles &&
      !hit(flags, flags.matchPattern, s.name)
    )
      continue
    if (rules.length > 0 && ignored(rules, names, childPath, isDir)) continue
    kept.push({
      node: {
        spec: sub,
        stat: s,
        isDir,
        leads,
        children: null,
        note: '',
        unopened: 0,
        du: contentSize(s),
        missing: false,
      },
      crossing,
    })
  }
  if (flags.fileLimit !== null && kept.length > flags.fileLimit)
    return {
      nodes: null,
      note: `  [${String(kept.length)} entries exceeds filelimit, not opening dir]`,
      unopened: 0,
      crossed: new Set(),
      rules: [],
    }
  return {
    nodes: await sorted(
      flags,
      kept.map((k) => k.node),
    ),
    note: '',
    unopened: 0,
    crossed: new Set(kept.filter((k) => k.crossing).map((k) => k.node)),
    rules,
  }
}

// Whether the walk goes into a drawn entry: a real directory, or under -l a
// link to one it has not been in, above -L, and inside the budget. A directory
// past the budget is drawn but not opened.
function opens(treeOpts: TreeOpts, node: TreeNode, depth: number): boolean {
  const { maxDepth, follow } = treeOpts.flags
  const linked = node.stat.type === FileType.SYMLINK
  if (node.stat.type !== FileType.DIRECTORY && !(linked && follow && node.isDir)) return false
  if (maxDepth !== null && depth + 1 >= maxDepth) return false
  if (treeOpts.budget !== undefined && !treeOpts.budget.opens(node.spec.virtual)) return false
  if (follow && treeOpts.resolve !== null) {
    const real = treeOpts.resolve(node.spec.virtual)
    if (linked && treeOpts.seen.has(real)) {
      node.note = RECURSIVE_MARK
      return false
    }
    treeOpts.seen.add(real)
  }
  return true
}

// Past a mount root the subtree belongs to another VFS, so the rest of this
// branch reads through the dispatcher. Deeper mounts under it need no second
// switch: the dispatcher already routes every path to its owner.
function readBelow(
  treeOpts: TreeOpts,
  listing: Listing,
  node: TreeNode,
  readdir: ReaddirFn<[p: PathSpec, nofollow?: boolean, limit?: number]>,
  stat: StatFn,
): [ReaddirFn<[p: PathSpec, nofollow?: boolean, limit?: number]>, StatFn] {
  if (node.stat.type === FileType.SYMLINK) return [treeOpts.crossReaddir ?? readdir, stat]
  if (!listing.crossed.has(node)) return [readdir, stat]
  return [treeOpts.crossReaddir ?? readdir, treeOpts.crossStat ?? stat]
}

async function walkTree(
  readdir: ReaddirFn<[p: PathSpec, nofollow?: boolean, limit?: number]>,
  stat: StatFn,
  path: PathSpec,
  treeOpts: TreeOpts,
  depth: number,
  inherited: readonly Ignore[] = [],
): Promise<{ nodes: TreeNode[] | null; note: string; unopened: number }> {
  const listing = await openDir(readdir, stat, path, treeOpts, inherited)
  if (listing.nodes === null) return listing
  let nodes = listing.nodes
  let unopened = 0
  for (const node of nodes) {
    if (!opens(treeOpts, node, depth)) continue
    const [subReaddir, subStat] = readBelow(treeOpts, listing, node, readdir, stat)
    const child = await walkTree(subReaddir, subStat, node.spec, treeOpts, depth + 1, listing.rules)
    node.children = child.nodes
    node.note = child.note
    node.unopened = child.unopened
    if (child.nodes !== null) node.du += child.nodes.reduce((sum, c) => sum + c.du, 0)
    unopened += child.unopened
  }
  if (treeOpts.flags.prune && !treeOpts.flags.dirsOnly)
    nodes = nodes.filter(
      (n) => n.stat.type !== FileType.DIRECTORY || (n.children?.length ?? 0) > 0 || n.note !== '',
    )
  return { nodes, note: '', unopened }
}

function counts(nodes: readonly TreeNode[]): [number, number] {
  let dirs = 0
  let files = 0
  for (const node of nodes) {
    if (!node.isDir) {
      files += 1
      continue
    }
    dirs += 1
    const [subDirs, subFiles] = counts(node.children ?? [])
    dirs += subDirs
    files += subFiles
  }
  return [dirs, files]
}

// The mark -F puts after a name: `/` a directory, `*` an executable, `|` a
// FIFO, none for anything else or nothing at all. Mirrors Python's
// `_classify`.
function classify(s: FileStat | null): string {
  if (s === null) return ''
  if (s.type === FileType.DIRECTORY) return '/'
  if (s.type === FileType.FIFO) return '|'
  if (s.type === FileType.FILE && (posixMode(s) & 0o111) !== 0) return '*'
  return ''
}

function size(flags: TreeFlags, node: TreeNode): number {
  return flags.du ? node.du : contentSize(node.stat)
}

/** A size as --si writes it, in powers of 1000. */
function siText(bytes: number): string {
  if (bytes < 1000) return String(bytes).padStart(4)
  let value = bytes
  let unit = -1
  while (value >= 1000 && unit < SI_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const digits = value < SI_TENTHS_BELOW ? 1 : 0
  // printf's rounding: the double's exact value, half to even, where toFixed
  // rounds a tie up.
  const [whole = '0', fraction = ''] = value.toFixed(60).split('.')
  const kept = fraction.slice(0, digits)
  const rest = fraction.slice(digits).replace(/0+$/, '')
  const up = rest > '5' || (rest === '5' && Number((whole + kept).slice(-1)) % 2 === 1)
  const rounded = (BigInt(whole + kept) + (up ? 1n : 0n)).toString().padStart(digits + 1, '0')
  const text = digits === 0 ? rounded : `${rounded.slice(0, -1)}.${rounded.slice(-1)}`
  return `${text}${SI_UNITS.charAt(unit)}`.padStart(4)
}

/** The time -D shows: the change time under -c, in the format --timefmt names. */
function timeText(flags: TreeFlags, node: TreeNode): string {
  const stamp = flags.changeTime ? timeOf(node.stat, 'ctime') : node.stat.modified
  return styledTime(stamp, flags.timeFormat === null ? 'locale' : `+${flags.timeFormat}`)
}

// The bracket --inodes, -p, -u, -g, -s (or --du, --si) and -D open a line
// with, empty without them. Mirrors Python's `_meta`.
function meta(flags: TreeFlags, node: TreeNode): string {
  const fields: string[] = []
  if (flags.inodes) fields.push(UNKNOWN_INODE.padStart(7))
  if (flags.perms) fields.push(lsModeString(node.stat))
  if (flags.owner) fields.push(ownerName(node.stat.uid, flags.identity).padEnd(8))
  if (flags.group) fields.push(groupName(node.stat.gid, flags.identity).padEnd(8))
  if (flags.si) fields.push(siText(size(flags, node)))
  else if (flags.sizes || flags.du) fields.push(String(size(flags, node)).padStart(11))
  if (flags.dates) fields.push(timeText(flags, node))
  return fields.length > 0 ? `[${fields.join(' ')}]  ` : ''
}

/** A name as the C locale draws it, one byte at a time. */
function cLocaleName(flags: TreeFlags, name: string): string {
  let drawn = ''
  for (const byte of encodeText(name)) {
    const escape = C_ESCAPES.get(byte)
    if (escape !== undefined) drawn += `\\${escape}`
    else if (byte === 0x5c) drawn += '\\\\'
    else if (byte === 0x20 && !flags.quote) drawn += '\\ '
    else if (byte === 0x22 && flags.quote) drawn += '\\"'
    else if (byte >= 0x20 && byte < 0x7f) drawn += String.fromCharCode(byte)
    else drawn += flags.question ? '?' : `\\${byte.toString(8).padStart(3, '0')}`
  }
  return drawn
}

/** A name as a UTF-8 locale draws it: a control character escaped or under -q
 * a `?`, a byte no character holds escaped or under -q left as it is, the rest
 * as they are. */
function utf8LocaleName(flags: TreeFlags, name: string): string {
  const raw = encodeText(name)
  const octal = (byte: number): number[] => [
    ...ENC.encode(`\\${byte.toString(8).padStart(3, '0')}`),
  ]
  const drawn: number[] = []
  let at = 0
  while (at < raw.length) {
    const width = charWidth(raw, at)
    const piece = [...raw.subarray(at, at + width)]
    const first = piece[0] ?? 0
    const second = piece[1] ?? 0
    at += width
    if (width === 1 && first >= 0x80) drawn.push(...(flags.question ? piece : octal(first)))
    else if (
      (width === 1 && (first < 0x20 || first === 0x7f)) ||
      (width === 2 && first === 0xc2 && second < 0xa0)
    ) {
      if (flags.question) drawn.push(0x3f)
      else for (const byte of piece) drawn.push(...octal(byte))
    } else drawn.push(...piece)
  }
  return decodeText(Uint8Array.from(drawn))
}

/** A name or link target as a line draws it, under -N, -q, -Q and the locale. */
function label(flags: TreeFlags, name: string): string {
  const drawn = flags.rawNames
    ? name
    : flags.utf8
      ? utf8LocaleName(flags, name)
      : cLocaleName(flags, name)
  return flags.quote ? `"${drawn}"` : drawn
}

function shown(flags: TreeFlags, node: TreeNode, root = false): string {
  const name = label(flags, flags.fullPath || root ? node.spec.rawPath : node.stat.name)
  if (node.stat.type === FileType.SYMLINK) {
    const tail = flags.classify ? classify(node.leads) : ''
    const target = node.stat.extra[LINK_TARGET_KEY]
    return `${name} -> ${label(flags, typeof target === 'string' ? target : '')}${tail}`
  }
  return name + (flags.classify ? classify(node.stat) : '')
}

/** What stands left of a name, in the locale's drawing set or under -A the
 * terminal's. */
function drawnLead(flags: TreeFlags, prefix: string, last: boolean): string {
  if (flags.noIndent) return ''
  if (!flags.ansiLines) {
    if (!flags.utf8) return prefix + (last ? LAST : BRANCH)
    return prefix.replaceAll(VERTICAL, UTF8_VERTICAL) + (last ? UTF8_LAST : UTF8_BRANCH)
  }
  const above = prefix.replaceAll(VERTICAL, ANSI_VERTICAL)
  return `${ANSI_OPEN}${above}${last ? ANSI_LAST : ANSI_BRANCH}${ANSI_CLOSE}`
}

function textLine(flags: TreeFlags, node: TreeNode, prefix: string, last: boolean): string {
  return drawnLead(flags, prefix, last) + meta(flags, node) + shown(flags, node) + node.note
}

function rootLine(flags: TreeFlags, root: TreeNode): string {
  const line = root.missing ? root.spec.rawPath : meta(flags, root) + shown(flags, root, true)
  return line + root.note
}

function textLines(flags: TreeFlags, nodes: readonly TreeNode[], prefix: string): string[] {
  const lines: string[] = []
  nodes.forEach((node, i) => {
    const last = i === nodes.length - 1
    lines.push(textLine(flags, node, prefix, last))
    if (node.children !== null && node.children.length > 0)
      for (const line of textLines(flags, node.children, prefix + (last ? INDENT : VERTICAL)))
        lines.push(line)
  })
  return lines
}

function flushed(drawing: Drawing): Uint8Array {
  const out = formatRecords(drawing.lines)
  drawing.lines = []
  return out
}

// A listed directory's lines, each written once its own listing is read. What
// is drawn so far goes out before the next directory is opened, so a reader
// that stops early stops the walk. Mirrors Python's `_draw`.
async function* draw(
  listing: Listing,
  readdir: ReaddirFn<[p: PathSpec, nofollow?: boolean, limit?: number]>,
  stat: StatFn,
  treeOpts: TreeOpts,
  depth: number,
  prefix: string,
  drawing: Drawing,
): AsyncGenerator<Uint8Array> {
  const nodes = listing.nodes ?? []
  for (const [i, node] of nodes.entries()) {
    const last = i === nodes.length - 1
    let below: Listing | null = null
    let subReaddir = readdir
    let subStat = stat
    if (opens(treeOpts, node, depth)) {
      if (drawing.lines.length > 0) yield flushed(drawing)
      ;[subReaddir, subStat] = readBelow(treeOpts, listing, node, readdir, stat)
      below = await openDir(subReaddir, subStat, node.spec, treeOpts, listing.rules)
      node.note = below.note
      drawing.unopened += below.unopened
    }
    drawing.lines.push(textLine(treeOpts.flags, node, prefix, last))
    if (node.isDir) drawing.dirs += 1
    else drawing.files += 1
    if (drawing.lines.length >= HELD_LINES) yield flushed(drawing)
    if (below === null) continue
    yield* draw(
      below,
      subReaddir,
      subStat,
      treeOpts,
      depth + 1,
      prefix + (last ? INDENT : VERTICAL),
      drawing,
    )
  }
}

const JSON_TYPES: ReadonlyMap<FileType, string> = new Map([
  [FileType.DIRECTORY, 'directory'],
  [FileType.SYMLINK, 'link'],
  [FileType.FIFO, 'fifo'],
])

// One entry as -J writes it: its fields on one line, a directory's contents
// below it one level in, all on one line under -i. Mirrors Python's
// `_json_entry`.
function jsonEntry(flags: TreeFlags, node: TreeNode, level: number, root = false): string {
  const name = flags.fullPath || root ? node.spec.rawPath : node.stat.name
  const kind = JSON_TYPES.get(node.stat.type) ?? 'file'
  let text = `{"type":"${kind}","name":${JSON.stringify(name)}`
  if (node.stat.type === FileType.SYMLINK) {
    const target = node.stat.extra[LINK_TARGET_KEY]
    text += `,"target":${JSON.stringify(typeof target === 'string' ? target : '')}`
  }
  if (flags.perms) {
    const mode = (posixMode(node.stat) & 0o7777).toString(8).padStart(4, '0')
    text += `,"mode":"${mode}","prot":"${lsModeString(node.stat)}"`
  }
  if (flags.owner) text += `,"user":"${ownerName(node.stat.uid, flags.identity)}"`
  if (flags.group) text += `,"group":"${groupName(node.stat.gid, flags.identity)}"`
  if (flags.sizes || flags.du || flags.si) text += `,"size":${String(size(flags, node))}`
  if (flags.dates) text += `,"time":"${timeText(flags, node)}"`
  if (node.note !== '') {
    const error = node.note.trim().replace(/^\[/, '').replace(/\]$/, '')
    const [newline, indent] = flags.noIndent ? ['', ''] : ['\n', '  '.repeat(level)]
    return `${text},"contents":[{"error": "${error}"}${newline}${indent}]}`
  }
  const children = node.children ?? []
  if (children.length === 0) return `${text}}`
  if (flags.noIndent)
    return `${text},"contents":[${children.map((c) => jsonEntry(flags, c, level + 1)).join(',')}]}`
  const pad = '  '.repeat(level + 1)
  const inner = children.map((c) => pad + jsonEntry(flags, c, level + 1)).join(',\n')
  return `${text},"contents":[\n${inner}\n${'  '.repeat(level)}]}`
}

function summary(dirs: number, files: number, dirsOnly: boolean): string {
  const dirWord = dirs === 1 ? 'directory' : 'directories'
  if (dirsOnly) return `${String(dirs)} ${dirWord}`
  return `${String(dirs)} ${dirWord}, ${String(files)} ${files === 1 ? 'file' : 'files'}`
}

function jsonReport(flags: TreeFlags, dirs: number, files: number, du: number): string {
  let text = '{"type":"report"'
  if (flags.du) text += `,"size":${String(du)}`
  text += `,"directories":${String(dirs)}`
  if (!flags.dirsOnly) text += `,"files":${String(files)}`
  return `${text}}`
}

// List a mount point -x keeps the walk out of: empty, the way tree draws a
// directory on another filesystem.
function notCrossed(): Promise<string[]> {
  return Promise.resolve([])
}

// The operands' drawing, under one summary; see `treeGeneric`. Mirrors
// Python's `_rendered`.
async function* rendered(
  targets: readonly PathSpec[],
  readdir: ReaddirFn<[p: PathSpec, nofollow?: boolean, limit?: number]>,
  stat: StatFn,
  treeOpts: TreeOpts,
  statPath: ReturnType<typeof vfsStatPath>,
  io: IOResult,
): AsyncGenerator<Uint8Array> {
  const flags = treeOpts.flags
  const live = !(flags.json || flags.prune || flags.du)
  const roots: TreeNode[] = []
  let totalDirs = 0
  let totalFiles = 0
  let anyError = false
  const stopped: string[] = []
  for (const p of targets) {
    let label = p.rawPath !== '' ? p.rawPath : p.virtual
    // -f names every entry from the operand, which drops the operand's
    // trailing slashes first (tree 2.2.1).
    if (flags.fullPath) label = rstripSlash(label) || '/'
    const spec = new PathSpec({
      virtual: p.virtual,
      directory: p.directory,
      resolved: p.resolved,
      vfsPath: p.vfsPath,
      rawPath: label,
    })
    // What the operand is decides the whole result, so it is resolved
    // before the walk rather than inferred from how a backend answered
    // readdir on it: an object store lists a file key as an empty prefix,
    // lists a missing path as one too, and Graph 404s, which read as
    // three different trees. The probe asks both channels a backend can
    // answer on, so a directory that exists only as its children still
    // reports as one and null means nothing is there.
    //
    // tree prints the same inline marker either way; what differs is the
    // count and the status. A non-directory exists, so it is counted and
    // the exit stays 0; a path that is not there is not counted and exits 2.
    const start = statPath === undefined ? null : await statPath(p)
    const row =
      start ??
      new FileStat({ name: label.slice(label.lastIndexOf('/') + 1), type: FileType.DIRECTORY })
    const root: TreeNode = {
      spec,
      stat: row,
      isDir: true,
      leads: null,
      children: null,
      note: '',
      unopened: 0,
      du: contentSize(row),
      missing: false,
    }
    roots.push(root)
    if (statPath !== undefined && start === null) {
      root.note = UNOPENABLE_MARK
      root.missing = true
      root.du = 0
      anyError = true
      if (live) yield formatRecords([rootLine(flags, root)])
      continue
    }
    if (start !== null && start.type !== FileType.DIRECTORY) {
      root.isDir = false
      root.note = UNOPENABLE_MARK
      totalFiles += 1
      if (live) yield formatRecords([rootLine(flags, root)])
      continue
    }
    const budget = new WalkBudget(p, treeOpts.mounts)
    const opts: TreeOpts = { ...treeOpts, budget, root: p.virtual, seen: new Set() }
    if (opts.flags.follow && opts.resolve !== null) opts.seen.add(opts.resolve(p.virtual))
    let counted: [number, number]
    if (live) {
      const listing = await openDir(readdir, stat, spec, opts, [])
      root.children = listing.nodes
      root.note = listing.note
      const drawing: Drawing = {
        lines: [rootLine(flags, root)],
        dirs: 0,
        files: 0,
        unopened: listing.unopened,
      }
      yield* draw(listing, readdir, stat, opts, 0, '', drawing)
      if (drawing.lines.length > 0) yield flushed(drawing)
      root.unopened = drawing.unopened
      counted = [drawing.dirs, drawing.files]
    } else {
      const walked = await walkTree(readdir, stat, spec, opts, 0)
      root.children = walked.nodes
      root.note = walked.note
      root.unopened = walked.unopened
      counted = counts(root.children ?? [])
    }
    for (const line of budget.stopped) stopped.push(`tree: ${line}`)
    if (root.children !== null) root.du += root.children.reduce((sum, c) => sum + c.du, 0)
    // With statPath wired the two clear cases are already answered above,
    // so this covers a directory that exists but could not be read (a
    // permission error).
    if (root.unopened > 0 && root.children === null) {
      anyError = true
      continue
    }
    // tree counts the root as a directory once it has any listed entry (an
    // empty root reports 0), or a note in place of them.
    if ((root.children?.length ?? 0) > 0 || root.note !== '') {
      totalDirs += counted[0] + 1
      totalFiles += counted[1]
    }
    // A directory below the root it could not open is marked inline and
    // makes the run exit 2, as tree does, with nothing on stderr.
    if (root.unopened > 0) anyError = true
  }
  // A walk past walkLimit draws what it listed and says where it stopped,
  // exiting 2 as for a directory it could not open.
  io.exitCode = anyError || stopped.length > 0 ? 2 : 0
  if (stopped.length > 0) io.stderr = formatRecords(stopped)
  const du = roots.reduce((sum, root) => sum + root.du, 0)
  if (live) {
    if (!flags.noReport) yield formatRecords(['', summary(totalDirs, totalFiles, flags.dirsOnly)])
  } else if (flags.json) {
    const report = jsonReport(flags, totalDirs, totalFiles, du)
    if (flags.noIndent) {
      const entries = roots.map((root) => jsonEntry(flags, root, 1, true))
      if (!flags.noReport) entries.push(report)
      yield ENC.encode(`[${entries.join(',')}]\n`)
    } else {
      const body = roots.map((root) => `  ${jsonEntry(flags, root, 1, true)}`).join(',\n')
      yield ENC.encode(`[\n${body}${flags.noReport ? '\n' : `\n,\n  ${report}`}\n]\n`)
    }
  } else {
    const lines: string[] = []
    for (const root of roots) {
      lines.push(rootLine(flags, root))
      for (const below of textLines(flags, root.children ?? [], '')) lines.push(below)
    }
    if (!flags.noReport) {
      let tail = summary(totalDirs, totalFiles, flags.dirsOnly)
      if (flags.du) {
        tail = flags.si
          ? ` ${siText(du)} used in ${tail}`
          : ` ${String(du).padStart(11)} bytes used in ${tail}`
      }
      lines.push('', tail)
    }
    yield formatRecords(lines)
  }
}

/**
 * Run tree over resolved operands, tree's drawing or its -J JSON, under one
 * summary. `unbounded` is the walk to take when no `-L` bounds it (one the
 * mount answers whole), else `readdir` and `stat`; `read` is the mount's
 * reader, for --gitignore. Mirrors Python's `tree_generic` and `tree`;
 * `parsed` holds the options, read before the operands were. The drawing is
 * written as the walk goes, unless an option needs a directory's whole subtree
 * before its first line: -J, --prune and --du. The status and any stderr
 * settle into the returned IOResult when the output has been read.
 */
export async function treeGeneric(
  parsed: TreeFlags,
  paths: PathSpec[],
  ctx: Context,
  readdir: (p: PathSpec, nofollow?: boolean, limit?: number) => Promise<string[]>,
  stat: (p: PathSpec) => Promise<FileStat>,
  unbounded?: [(p: PathSpec) => Promise<string[]>, (p: PathSpec) => Promise<FileStat>],
  read: ReadStreamFn | null = null,
): Promise<CommandFnResult> {
  if (unbounded !== undefined && parsed.maxDepth === null && !parsed.follow) {
    ;[readdir, stat] = unbounded
  }
  const flags: TreeFlags = {
    ...parsed,
    utf8: utf8Locale(ctx.env),
    identity: identityOf(ctx),
  }
  const output = parsed.output
  if (output !== null) {
    if (ctx.vfs === undefined) return [null, new IOResult({ exitCode: 1 })]
    try {
      await ctx.vfs.write(output, new Uint8Array(0))
    } catch (error) {
      if (!isFsError(error)) throw error
      const line = `tree: invalid filename '${output.rawPath}'\n`
      return [null, new IOResult({ exitCode: 1, stderr: encodeText(line) })]
    }
  }
  const targets =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            virtual: ctx.cwd.virtual,
            directory: ctx.cwd.virtual,
            resolved: false,
            vfsPath: ctx.cwd.vfsPath,
          }),
        ]
  const readdirPath = vfsReaddirPath(ctx.vfs)
  const statPath = vfsStatPath(ctx.vfs)
  const links = linksOf(ctx)
  const treeOpts: TreeOpts = {
    flags,
    mounts: mountsOf(ctx) ?? null,
    crossReaddir:
      readdirPath === undefined
        ? null
        : flags.oneFileSystem
          ? notCrossed
          : (p: PathSpec) => readdirPath(p.virtual),
    crossStat:
      statPath === undefined
        ? null
        : async (p: PathSpec) => {
            const s = await statPath(p)
            // Stamped, not a bare Error: `isWalkError` keys on the code,
            // so an unstamped throw escapes the walk's catch and rejects
            // the whole run instead of skipping one vanished entry. The
            // python twin raises FileNotFoundError, which `WALK_ERRORS`
            // already covers.
            if (s === null) throw enoent(p)
            return s
          },
    targetStat: links === undefined ? null : (path: string) => links.targetStat(path),
    read,
    resolve: links === undefined ? null : (path: string) => links.resolve(path),
    seen: new Set(),
  }
  const io = new IOResult()
  const pieces = rendered(targets, readdir, stat, treeOpts, statPath, io)
  // The first piece is drawn here, so what refuses the walk outright still
  // rejects before there is any output.
  const first = await pieces.next()
  const body = asyncChain([first.done === true ? null : first.value, pieces])
  if (output === null || ctx.vfs === undefined) return [body, io]
  await ctx.vfs.write(output, body)
  return [null, io]
}

/**
 * A tree line reads below every path it names and walks into the mounts below
 * unless `-x`. Mirrors Python's `facts`.
 */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({
    walks: !fl.asBool('x'),
    readsSubtree: true,
    writes: fl.asPath('o') !== undefined,
  })
}
