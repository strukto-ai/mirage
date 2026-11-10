import type { FlagView } from '../../../spec/flag_view.ts'
import { pairRenames, kindOf } from './changes.ts'
import { combinedLines } from './combined.ts'
import { TEMPLATE_KINDS, TERMINATED_KINDS } from './constants.ts'
import { GitError, DiffFilterError } from './errors.ts'
import { pathspecSelects } from './pathspec.ts'
import { commitHeader, type CommitDisplay, type CommitFacts, type Decorations } from './format.ts'
import { blobData, DEV_NULL, filePatch, HUNK_CONTEXT, OID_HEX, shortOid } from './patch.ts'
import { quotePath } from './render.ts'
import { deltas, shownSides, type Delta, type Side } from './rows.ts'
import { configValues } from './fs.ts'
import { abbrevWidth } from './format.ts'
import { maybeBool } from './util.ts'
import { commitFacts, type Repo } from './repo.ts'
import { readable, shownEntries } from './seen.ts'
import { BINARY_SNIFF, diffstat, statTable, type FileStat } from './summary.ts'
import { matches, type Pickaxe } from './pickaxe.ts'
import { TREE_MODE, treeEntries, treeItems, type TreeEntry } from './tree.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const RENAME_SCORE = 50
const UNMERGED = 'U'
const CHANGE_CLASSES = 'ACDMRTUXB'
// What a combined diff's mode line starts with; `log --graph` prints that line
// with no graph in front of it.
export const COMBINED_MODE = 'mode '

/** One interpretation of Git diff options, shared by all tree readers. */
export interface DiffFlags {
  nameOnly: boolean
  nameStatus: boolean
  stat: boolean
  numstat: boolean
  shortstat: boolean
  summary: boolean
  patch: boolean
  noPatch: boolean
  renames: number | null
  merge: string
  raw: boolean
  abbrev: boolean
  functionContext: boolean
  forceText: boolean
  context: number
  quotePathFully: boolean
  pathspecs: readonly string[]
  pickaxe?: Pickaxe | null
  diffFilter?: readonly [ReadonlySet<string>, boolean] | null
  prefixes?: readonly [string, string]
  indexWidth?: number | null
  rawWidth?: number | null
  workTree?: boolean
  sameAsIndex?: ReadonlySet<string>
  unmerged?: ReadonlyMap<string, readonly [TreeEntry | null, TreeEntry | null, TreeEntry | null]>
}

/**
 * A `--diff-filter` value as the classes it keeps. Capitals keep a class and
 * small letters drop one, so only small letters start from every class. `*`
 * keeps a whole comparison when any of its paths matches.
 */
export function diffFilterOf(
  spelled: string | undefined,
): readonly [ReadonlySet<string>, boolean] | null {
  if (spelled === undefined || spelled === '') return null
  const letters = Array.from(spelled).filter((char) => char !== '*')
  const star = spelled.includes('*')
  const dropsOnly = letters.length > 0 && letters.every((char) => char !== char.toUpperCase())
  const chosen = new Set<string>(dropsOnly ? CHANGE_CLASSES : '')
  for (const char of letters) {
    const upper = char.toUpperCase()
    if (!CHANGE_CLASSES.includes(upper)) throw new DiffFilterError(char, spelled)
    if (char === upper) chosen.add(char)
    else chosen.delete(upper)
  }
  return [chosen, star]
}

/** The changes `--diff-filter` keeps. */
export function filtered(rows: Change[], flags: DiffFlags): Change[] {
  if (flags.diffFilter === undefined || flags.diffFilter === null) return rows
  const [chosen, star] = flags.diffFilter
  const kept = rows.filter((row) => chosen.has(row.status))
  return star ? (kept.length ? rows : []) : kept
}

/** The `diff` variables that choose a patch's prefixes. */
export async function prefixConfig(repo: Repo): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {}
  for (const name of ['noprefix', 'srcprefix', 'dstprefix'])
    out[name] = (await configValues(repo.vfs, repo.location, `diff.${name}`)).at(-1)
  return out
}

function prefixesOf(
  fl: FlagView,
  settings: Record<string, string | undefined>,
): readonly [string, string] {
  let source = 'a/'
  let target = 'b/'
  if (settings.noprefix !== undefined && maybeBool(settings.noprefix) === true) {
    source = ''
    target = ''
  }
  source = settings.srcprefix ?? source
  target = settings.dstprefix ?? target
  for (const [name, value] of fl.occurrences(
    'no_prefix',
    'default_prefix',
    'src_prefix',
    'dst_prefix',
  )) {
    if (name === 'no_prefix') {
      source = ''
      target = ''
    } else if (name === 'default_prefix') {
      source = 'a/'
      target = 'b/'
    } else if (name === 'src_prefix' && typeof value === 'string') source = value
    else if (name === 'dst_prefix' && typeof value === 'string') target = value
  }
  return [source, target]
}

/** A similarity option's value as a percentage: `50%`, or a fraction's digits as in `-M5`. */
export function similarity(spelled: string): number {
  const value = spelled.endsWith('%')
    ? Number(spelled.slice(0, -1))
    : Math.floor(Number(`0.${spelled}`) * 100)
  if (!Number.isFinite(value)) throw new GitError(`invalid similarity index ${spelled}`)
  return value
}

export function parseDiffFlags(
  fl: FlagView,
  defaultPatch = true,
  defaultMerge = 'off',
  porcelain = true,
  defaultRenames = true,
  quotePathFully = true,
  prefixSettings: Record<string, string | undefined> = {},
): DiffFlags {
  const nameOnly = fl.asBool('name_only'),
    nameStatus = fl.asBool('name_status'),
    stat = fl.asBool('stat'),
    numstat = fl.asBool('numstat'),
    shortstat = fl.asBool('shortstat'),
    summary = fl.asBool('summary'),
    raw = fl.asBool('raw')
  const modes = nameOnly || nameStatus || stat || numstat || shortstat || summary || raw
  const rename = fl.raw('find_renames')
  let threshold: number | null = porcelain && defaultRenames ? RENAME_SCORE : null
  if (rename !== undefined && rename !== false) {
    threshold = RENAME_SCORE
    if (typeof rename === 'string' && rename !== '') threshold = similarity(rename)
  }
  if (fl.asBool('no_renames')) threshold = null
  let merge = fl.asStr('diff_merges', defaultMerge)
  if (fl.asBool('m')) merge = 'separate'
  if (fl.asBool('c')) merge = 'combined'
  if (fl.asBool('cc')) merge = 'dense-combined'
  if (porcelain && fl.asBool('first_parent')) merge = 'first-parent'
  const aliases: Record<string, string> = {
    '0': 'off',
    '1': 'separate',
    on: 'separate',
    m: 'separate',
    c: 'combined',
    cc: 'dense-combined',
  }
  merge = aliases[merge] ?? merge
  if (!['off', 'separate', 'combined', 'dense-combined', 'first-parent'].includes(merge))
    throw new GitError(`invalid value for '--diff-merges': '${merge}'`)
  const context = fl.asInt('unified') ?? HUNK_CONTEXT
  if (context < 0) throw new GitError('negative context length')
  const patch =
    fl.asBool('patch') ||
    fl.asBool('function_context') ||
    fl.asInt('unified') != null ||
    ((defaultPatch || fl.asBool('cc') || (porcelain && fl.asBool('c'))) && !modes)
  const abbrevWanted = fl.raw('abbrev')
  const named = typeof abbrevWanted === 'string' ? abbrevWidth(abbrevWanted, OID_HEX) : null
  return {
    diffFilter: diffFilterOf(fl.asStr('diff_filter')),
    prefixes: prefixesOf(fl, prefixSettings),
    indexWidth: fl.asBool('full_index') ? OID_HEX : named,
    rawWidth: fl.asBool('no_abbrev') ? OID_HEX : named,
    context,
    functionContext: fl.asBool('function_context'),
    forceText: fl.asBool('text'),
    nameOnly,
    nameStatus,
    stat,
    numstat,
    shortstat,
    summary,
    patch,
    noPatch: fl.asBool('no_patch'),
    renames: threshold,
    merge,
    raw: raw || (!porcelain && !modes && !patch),
    abbrev: porcelain || abbrevWanted === true,
    quotePathFully,
    pathspecs: [],
  }
}

interface Change {
  path: string
  oldPath: string
  old: TreeEntry | null
  new: TreeEntry | null
  status: string
  score: number
}

export async function compare(
  repo: Repo,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  threshold: number | null,
): Promise<Change[]> {
  const codes = new Map<string, string>(),
    oids = new Map<string, string>(),
    kinds = new Map<string, string>()
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(compareCodePoints)) {
    const a = before.get(path),
      b = after.get(path)
    if (a?.oid === b?.oid && a?.mode === b?.mode) continue
    codes.set(path, !a ? 'A' : !b ? 'D' : a.mode.slice(0, 3) !== b.mode.slice(0, 3) ? 'T' : 'M')
    const entry = b ?? a
    if (entry) {
      oids.set(path, entry.oid)
      kinds.set(path, kindOf(entry.mode))
    }
  }
  const pairs =
    threshold === null
      ? new Map([...codes].map(([p, c]) => [p, [c, null, 0] as const]))
      : await pairRenames(repo, codes, oids, kinds, threshold)
  const rows: Change[] = []
  for (const [path, [status, origin, score]] of [...pairs].sort((a, b) =>
    compareCodePoints(a[0], b[0]),
  )) {
    const oldPath = origin ?? path,
      old = before.get(oldPath) ?? null,
      now = after.get(path) ?? null
    rows.push({ path, oldPath, old, new: now, status, score })
  }
  return rows
}

/**
 * How a rename names its paths in a diffstat, as git prints it: when either
 * side needs quoting the two quoted paths stand whole, otherwise the shared
 * leading and trailing directories fold into `pre/{old => new}/post`.
 */
function renameName(old: string, fresh: string, fully = true): string {
  const quotedOld = quotePath(old, false, fully),
    quotedFresh = quotePath(fresh, false, fully)
  if (quotedOld !== old || quotedFresh !== fresh) return `${quotedOld} => ${quotedFresh}`
  const a = old.split('/'),
    b = fresh.split('/'),
    prefix: string[] = [],
    suffix: string[] = []
  while (a.length > 1 && b.length > 1 && a[0] === b[0]) {
    prefix.push(a.shift() ?? '')
    b.shift()
  }
  while (a.length > 1 && b.length > 1 && a.at(-1) === b.at(-1)) {
    suffix.unshift(a.pop() ?? '')
    b.pop()
  }
  const middle = `${a.join('/')} => ${b.join('/')}`
  return prefix.length || suffix.length ? [...prefix, `{${middle}}`, ...suffix].join('/') : middle
}

function textLines(data: Uint8Array): string[] {
  const text = new TextDecoder().decode(data)
  return text === '' ? [] : text.split(/(?<=\n)/)
}

/**
 * Every requested format for one two-tree comparison, in git's order:
 * `--name-only` and `--name-status` stand alone; otherwise raw rows come first,
 * then numstat, stat and summary, then a blank line and the patch.
 */
function showsNewId(row: Change, flags: DiffFlags): boolean {
  return flags.workTree !== true || flags.sameAsIndex?.has(row.path) === true
}

/** The rows with a `U` row before each conflicted path's own. */
export function withUnmerged(rows: Change[], flags: DiffFlags): Change[] {
  if (flags.unmerged === undefined || flags.unmerged.size === 0) return rows
  const marks = [...flags.unmerged].map(([path, ends]): Change => ({
    path,
    oldPath: path,
    old: null,
    new: ends[2],
    status: UNMERGED,
    score: 0,
  }))
  return [...marks, ...rows].sort(
    (a, b) =>
      compareCodePoints(a.path, b.path) ||
      Number(a.status !== UNMERGED) - Number(b.status !== UNMERGED),
  )
}

/** A conflicted path's dense combined diff against the working tree. */
async function unmergedPatch(repo: Repo, path: string, flags: DiffFlags): Promise<string> {
  const [ours, theirs, work] = flags.unmerged?.get(path) ?? [null, null, null]
  const against = (old: TreeEntry | null): Map<string, Change> =>
    new Map([[path, { path, oldPath: path, old, new: work, status: 'M', score: 0 }]])
  return combinedPatch(
    repo,
    [against(ours), against(theirs)],
    [path],
    true,
    flags.quotePathFully,
    flags.context,
    flags.prefixes,
    flags.indexWidth,
    true,
  )
}

export async function renderChanges(
  repo: Repo,
  input: Change[],
  flags: DiffFlags,
): Promise<string> {
  const rows = filtered(withUnmerged(input, flags), flags)
  if (flags.noPatch) return ''
  const width = flags.rawWidth ?? (flags.abbrev ? repo.abbrev : OID_HEX)
  const fully = flags.quotePathFully
  let output: string[] = []
  const numbers: string[] = [],
    summaries: string[] = []
  const stats: FileStat[] = [],
    patches: string[] = []
  const combined = new Set<string>()
  for (const row of rows) {
    const shown = quotePath(row.path, false, fully)
    const status = row.status === 'R' ? `R${String(row.score).padStart(3, '0')}` : row.status
    const paths = row.status === 'R' ? `${quotePath(row.oldPath, false, fully)}\t${shown}` : shown
    if (flags.nameOnly) {
      output.push(shown)
      continue
    }
    if (flags.nameStatus) {
      output.push(`${status}\t${paths}`)
      continue
    }
    if (flags.raw)
      output.push(
        `:${row.old?.mode ?? '000000'} ${row.new?.mode ?? '000000'} ${shortOid(row.old, width)} ${shortOid(showsNewId(row, flags) ? row.new : null, width)} ${status}\t${paths}`,
      )
    const display = row.status === 'R' ? renameName(row.oldPath, row.path, fully) : shown
    if (flags.stat || flags.numstat || flags.shortstat)
      stats.push(
        row.status === UNMERGED
          ? {
              path: display,
              insertions: 0,
              deletions: 0,
              binary: false,
              oldSize: 0,
              newSize: 0,
              unmerged: true,
            }
          : await rowStat(repo, row, display),
      )
    const stat = stats.at(-1)
    if (flags.numstat && stat)
      numbers.push(
        `${stat.binary ? '-\t-' : `${String(stat.insertions)}\t${String(stat.deletions)}`}\t${display}`,
      )
    if (flags.summary) for (const item of summaryLines(row, display, shown)) summaries.push(item)
    if (flags.patch && flags.unmerged?.has(row.path) === true) {
      if (!combined.has(row.path)) {
        combined.add(row.path)
        patches.push(await unmergedPatch(repo, row.path, flags))
      }
    } else if (flags.patch)
      patches.push(
        await filePatch(
          repo,
          row.path,
          row.oldPath,
          row.old,
          row.new,
          row.status === 'R' ? row.score : null,
          flags.indexWidth ?? repo.abbrev,
          fully,
          flags.context,
          flags.functionContext,
          flags.forceText,
          flags.prefixes,
        ),
      )
  }
  if (!(flags.nameOnly || flags.nameStatus)) {
    const table = statTable(stats)
    output = [
      ...output,
      ...numbers,
      ...(flags.stat ? table : flags.shortstat ? table.slice(-1) : []),
      ...summaries,
    ]
  }
  const head = output.map((l) => l + '\n').join(''),
    body = patches.join('')
  return head + (head && body ? '\n' : '') + body
}

/** The diffstat row for one change, named the way git prints it. */
async function rowStat(repo: Repo, row: Change, display: string): Promise<FileStat> {
  const before = new Map(row.old ? [[row.path, row.old]] : []),
    after = new Map(row.new ? [[row.path, row.new]] : [])
  // Counting lines reads both sides, as a patch does.
  for (const side of [row.old, row.new]) if (side !== null) readable(repo, side.oid)
  const counted = (await diffstat(repo, before, after))[0]
  if (counted) return { ...counted, path: display }
  const fresh = (await diffstat(repo, new Map(), after))[0]
  if (!fresh) throw new Error('Missing renamed entry')
  return { ...fresh, path: display, insertions: 0, deletions: 0, oldSize: fresh.newSize }
}

/** The `--summary` lines for one change, as git prints them. */
function summaryLines(row: Change, display: string, shown: string): string[] {
  const old = row.old,
    fresh = row.new
  if (row.status === 'R') {
    const lines = [` rename ${display} (${String(row.score)}%)`]
    if (old && fresh && old.mode !== fresh.mode)
      lines.push(` mode change ${old.mode} => ${fresh.mode}`)
    return lines
  }
  if (!old && fresh) return [` create mode ${fresh.mode} ${shown}`]
  if (!fresh && old) return [` delete mode ${old.mode} ${shown}`]
  if (old && fresh && old.mode !== fresh.mode)
    return [` mode change ${old.mode} => ${fresh.mode} ${shown}`]
  return []
}

/**
 * A tree's entries a diff compares, limited to a pathspec.
 *
 * @param repo repository to read
 * @param tree the tree id, null for the empty tree
 * @param recursive whether to descend into subtrees
 * @param pathspecs repository-relative patterns, all paths when empty
 */
export async function entries(
  repo: Repo,
  tree: string | null,
  recursive: boolean,
  pathspecs: readonly string[] = [],
): Promise<Map<string, TreeEntry>> {
  if (tree === null) return new Map()
  const found = recursive
    ? await treeEntries(repo, tree)
    : new Map((await treeItems(repo, tree)).map((e) => [e.path, { mode: e.mode, oid: e.oid }]))
  // A commit's tree stands at the root; what the session cannot see there is
  // no side of any change, so no patch, count or match.
  return limited(shownEntries(repo, found), pathspecs)
}

/**
 * The entries a pathspec names, all of them for none.
 *
 * Applied before pairing, so a rename is found only where both paths match
 * (pinned against git 2.54).
 *
 * @param found path to entry
 * @param pathspecs repository-relative patterns
 */
export function limited(
  found: Map<string, TreeEntry>,
  pathspecs: readonly string[],
): Map<string, TreeEntry> {
  if (!pathspecs.length) return found
  return new Map(
    [...found].filter(([path, entry]) =>
      pathspecSelects(path, pathspecs, entry.mode === TREE_MODE),
    ),
  )
}

/**
 * The counts and summary lines `git commit` prints under its title.
 *
 * `--shortstat --summary` of the change, with renames found at git's default
 * score whatever `diff.renames` says, which is how git's commit summary reads
 * (pinned against git 2.50).
 *
 * @param repo repository to read blobs from
 * @param before the parent tree
 * @param after the new tree
 * @param fully `core.quotePath`
 */
export async function commitSummary(
  repo: Repo,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  fully = true,
): Promise<string> {
  return renderChanges(repo, await compare(repo, before, after, RENAME_SCORE), {
    context: 3,
    functionContext: false,
    forceText: false,
    nameOnly: false,
    nameStatus: false,
    stat: false,
    numstat: false,
    shortstat: true,
    summary: true,
    patch: false,
    noPatch: false,
    renames: RENAME_SCORE,
    merge: 'off',
    raw: false,
    abbrev: true,
    quotePathFully: fully,
    pathspecs: [],
  })
}

/**
 * The pairs of one comparison a pickaxe keeps: the ones it matches, or every
 * pair under `--pickaxe-all` once one matches, and none when none does.
 *
 * The search runs on the pairs as renames left them, so a rename that keeps the
 * count matches nothing however many times the string occurs (git 2.47.3).
 *
 * @param repo repository holding the blobs
 * @param rows one comparison's pairs
 * @param pickaxe the search, null for none
 */
export async function picked(
  repo: Repo,
  rows: Change[],
  pickaxe: Pickaxe | null | undefined,
): Promise<Change[]> {
  if (!pickaxe) return rows
  const kept: Change[] = []
  for (const row of rows) if (await matches(repo, pickaxe, row.old, row.new)) kept.push(row)
  return kept.length && pickaxe.every ? rows : kept
}

/** The pairs one comparison's diff block shows, the pickaxe applied. */
async function rowsOf(
  repo: Repo,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  flags: DiffFlags,
): Promise<Change[]> {
  return picked(repo, await compare(repo, before, after, flags.renames), flags.pickaxe)
}

/**
 * One comparison's diff block, null when its sides do not differ or the pickaxe
 * keeps none of its pairs.
 */
async function block(
  repo: Repo,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  flags: DiffFlags,
): Promise<string | null> {
  const rows = await rowsOf(repo, before, after, flags)
  return filtered(rows, flags).length ? renderChanges(repo, rows, flags) : null
}

/**
 * The comparisons a commit's diff makes, one per parent the merge mode
 * compares, each limited to the pathspec.
 *
 * A root commit compares with the empty tree when `root` says so, and a merge
 * under `--diff-merges=off` makes none. Mirrors Python's `commit_sides`.
 *
 * @param repo repository to read
 * @param commit the commit to diff
 * @param flags the diff flags
 * @param recursive whether to descend into subtrees
 * @param root whether a root commit diffs against the empty tree
 */
export async function commitSides(
  repo: Repo,
  commit: CommitFacts,
  flags: DiffFlags,
  recursive = true,
  root = true,
): Promise<Side[]> {
  let trees: string[] = []
  for (const p of commit.parents) trees.push((await commitFacts(repo, p)).tree)
  if (!trees.length && !root) return []
  if (trees.length === 1 || flags.merge === 'first-parent') trees = trees.slice(0, 1)
  else if (trees.length > 1 && flags.merge === 'off') return []
  const after = await entries(repo, commit.tree, recursive, flags.pathspecs)
  if (!trees.length) return [[new Map(), after]]
  const sides: Side[] = []
  for (const tree of trees)
    sides.push([await entries(repo, tree, recursive, flags.pathspecs), after])
  return sides
}

/**
 * Whether a log the pickaxe filters prints a commit.
 *
 * A commit with one parent or none is printed when the pickaxe keeps a pair of
 * its diff. A merge follows the merge diff: never by default, when its first
 * parent's diff keeps one under first-parent, when any parent's does under
 * `-m`, and always under `-c` and `--cc`, whatever the pickaxe says (git
 * 2.47.3).
 *
 * @param repo repository to read
 * @param commit the commit
 * @param flags the diff flags, carrying the pickaxe
 */
export async function shows(repo: Repo, commit: CommitFacts, flags: DiffFlags): Promise<boolean> {
  if ((!flags.pickaxe && !flags.diffFilter) || isCombined(commit, flags)) return true
  for (const [before, after] of await commitSides(repo, commit, flags))
    if (filtered(await rowsOf(repo, before, after, flags), flags).length) return true
  return false
}

/**
 * Every commit's comparisons as rows, and which comparisons are whose.
 *
 * Made one commit at a time, so only the changed paths of a long log are
 * held. Mirrors Python's `commit_deltas`.
 *
 * @param repo repository to read
 * @param commits the commits whose diffs print
 * @param flags the diff flags
 * @param recursive whether to descend into subtrees
 * @param root whether a root commit diffs against the empty tree
 */
export async function commitDeltas(
  repo: Repo,
  commits: readonly CommitFacts[],
  flags: DiffFlags,
  recursive = true,
  root = true,
): Promise<[Delta[], Map<string, [number, number]>]> {
  const rows: Delta[] = []
  const spans = new Map<string, [number, number]>()
  let count = 0
  for (const commit of commits) {
    if (spans.has(commit.oid)) continue
    const sides = await commitSides(repo, commit, flags, recursive, root)
    for (const row of deltas(repo.location, sides, count)) rows.push(row)
    spans.set(commit.oid, [count, count + sides.length])
    count += sides.length
  }
  return [rows, spans]
}

/**
 * Each commit's comparisons, holding only the rows the session sees. Mirrors
 * Python's `commit_shown`.
 *
 * @param shown the rows the command boundary kept
 * @param spans which comparisons are whose, as `[start, stop)`
 */
export function commitShown(
  shown: readonly Delta[],
  spans: ReadonlyMap<string, readonly [number, number]>,
): Map<string, Side[]> {
  let count = 0
  for (const [, stop] of spans.values()) count = Math.max(count, stop)
  const sides = shownSides(shown, count)
  return new Map([...spans].map(([commit, [start, stop]]) => [commit, sides.slice(start, stop)]))
}

/**
 * A commit's diff blocks, one per comparison `commitSides` made.
 *
 * A comparison that does not differ is null, so its header is not printed
 * either (pinned against git 2.54).
 *
 * @param repo repository to read
 * @param commit the commit to diff
 * @param flags the diff flags
 * @param sides its comparisons, as the session sees them
 */
export async function commitOutput(
  repo: Repo,
  commit: CommitFacts,
  flags: DiffFlags,
  sides: readonly Side[],
): Promise<(string | null)[]> {
  if (!sides.length || !isCombined(commit, flags)) {
    const out: (string | null)[] = []
    for (const [before, after] of sides) out.push(await block(repo, before, after, flags))
    return out
  }
  const comparisons: Change[][] = []
  for (const [before, after] of sides) comparisons.push(await rowsOf(repo, before, after, flags))
  const maps = comparisons.map((rows) => new Map(rows.map((row) => [row.path, row])))
  const common = combinedPaths(
    maps,
    [...(maps[0]?.keys() ?? [])]
      .filter((path) => maps.every((m) => m.has(path)))
      .sort(compareCodePoints),
    flags,
  )
  if (flags.noPatch) return []
  const width = flags.abbrev ? repo.abbrev : OID_HEX
  const names = flags.nameOnly || flags.nameStatus
  const stat =
    !names && (flags.stat || flags.numstat || flags.shortstat || flags.summary)
      ? await renderChanges(repo, comparisons[0] ?? [], { ...flags, patch: false, raw: false })
      : ''
  const listing = (names || flags.raw ? common : [])
    .map((path) => {
      const rows = maps.map((m) => changeAt(m, path)),
        status = rows.map((r) => r.status).join(''),
        shown = quotePath(path, false, flags.quotePathFully)
      if (flags.nameOnly) return shown + '\n'
      if (flags.nameStatus) return `${status}\t${shown}\n`
      const ends = [...rows.map((r) => r.old), rows[0]?.new ?? null]
      return (
        ':'.repeat(maps.length) +
        ends.map((e) => e?.mode ?? '000000').join(' ') +
        ' ' +
        ends.map((e) => shortOid(e, width)).join(' ') +
        ` ${status}\t${shown}\n`
      )
    })
    .join('')
  const head = stat + listing
  const body =
    flags.patch && !names
      ? await combinedPatch(
          repo,
          maps,
          common,
          flags.merge === 'dense-combined',
          flags.quotePathFully,
          flags.context,
          flags.prefixes,
          flags.indexWidth,
        )
      : ''
  return [head + (head && body ? '\n' : '') + body]
}

/**
 * The paths `--diff-filter` keeps in a combined diff: a path stays only when its
 * status against every parent is one the filter keeps, and with `*` one kept
 * status anywhere keeps them all.
 */
function combinedPaths(
  maps: readonly Map<string, Change>[],
  paths: string[],
  flags: DiffFlags,
): string[] {
  if (flags.diffFilter === undefined || flags.diffFilter === null) return paths
  const [chosen, star] = flags.diffFilter
  const kept = (path: string, m: Map<string, Change>): boolean =>
    chosen.has(m.get(path)?.status ?? '')
  if (star) return paths.some((path) => maps.some((m) => kept(path, m))) ? paths : []
  return paths.filter((path) => maps.every((m) => kept(path, m)))
}

/** Binary combined patches stay binary under `--text`, as in Git 2.50.1. */
async function combinedPatch(
  repo: Repo,
  maps: Map<string, Change>[],
  paths: string[],
  dense: boolean,
  fully = true,
  context = 3,
  prefixes: readonly [string, string] = ['a/', 'b/'],
  indexWidth: number | null | undefined = null,
  workTree = false,
): Promise<string> {
  const output: string[] = []
  for (const path of paths) {
    const rows = maps.map((m) => changeAt(m, path)),
      fresh = rows[0]?.new ?? null,
      old = rows.map((r) => r.old)
    const data = await blobData(repo, fresh),
      parents: Uint8Array[] = []
    for (const entry of old) parents.push(await blobData(repo, entry))
    const binary = [...parents, data].some((d) => d.subarray(0, BINARY_SNIFF).includes(0))
    const body = binary
      ? []
      : combinedLines(parents.map(textLines), textLines(data), dense, context)
    const mode = fresh?.mode ?? '000000'
    const moved = old.some((e) => (e?.mode ?? '000000') !== mode)
    if (!binary && !body.length && !moved) continue
    const deleted = fresh === null,
      created = !deleted && rows.every((r) => r.status === 'A')
    output.push(`diff --${dense ? 'cc' : 'combined'} ${quotePath(path, false, fully)}\n`)
    output.push(
      'index ' +
        old.map((e) => shortOid(e, indexWidth ?? repo.abbrev)).join(',') +
        '..' +
        shortOid(workTree ? null : fresh, indexWidth ?? repo.abbrev) +
        '\n',
    )
    if (moved && created) output.push(`new file mode ${mode}\n`)
    else if (moved)
      output.push(
        (deleted ? 'deleted file mode ' : COMBINED_MODE) +
          old.map((e) => e?.mode ?? '000000').join(',') +
          (deleted ? '' : `..${mode}`) +
          '\n',
      )
    if (binary) {
      output.push('Binary files differ\n')
      continue
    }
    output.push(
      `--- ${created ? DEV_NULL : quotePath(`${prefixes[0]}${path}`, false, fully)}\n`,
      `+++ ${deleted ? DEV_NULL : quotePath(`${prefixes[1]}${path}`, false, fully)}\n`,
    )
    for (const line of body) output.push(line)
  }
  return output.join('')
}

function changeAt(rows: ReadonlyMap<string, Change>, path: string): Change {
  const row = rows.get(path)
  if (!row) throw new Error(`Missing combined-diff entry: ${path}`)
  return row
}

export async function renamesEnabled(repo: Repo): Promise<boolean> {
  const value = (await configValues(repo.vfs, repo.location, 'diff.renames')).at(-1)
  return value === undefined || !['false', 'no', 'off', '0', ''].includes(value.toLowerCase())
}

/**
 * Whether a commit's diff is a combined one (`-c`, `--cc`), which only a merge
 * gets.
 *
 * @param commit the commit whose diff follows
 * @param flags the diff flags
 */
export function isCombined(commit: CommitFacts, flags: DiffFlags): boolean {
  return (
    commit.parents.length > 1 && (flags.merge === 'combined' || flags.merge === 'dense-combined')
  )
}

/**
 * The line git prints between a commit's text and its diff, null for none.
 *
 * `---` when both a diffstat and a patch follow, otherwise an empty line,
 * and none under oneline. A combined diff (`-c`, `--cc`) always gets the
 * empty line, oneline included. Pinned against git 2.50.1.
 *
 * @param commit the commit whose diff follows
 * @param kind the pretty format's kind
 * @param flags the diff flags
 */
export function separatorLine(commit: CommitFacts, kind: string, flags: DiffFlags): string | null {
  if (isCombined(commit, flags)) return ''
  if (kind === 'oneline') return null
  return flags.stat && flags.patch ? '---' : ''
}

export function joinOutput(
  commit: CommitFacts,
  head: string,
  bodies: readonly (string | null)[],
  kind: string,
  width: number,
  flags: DiffFlags,
  emptySummary = false,
): string {
  if (!bodies.length) return head
  const line = separatorLine(commit, kind, flags)
  const blocks: string[] = []
  bodies.forEach((body, index) => {
    if (body === null) return
    let text = head
    if (bodies.length > 1 && !TEMPLATE_KINDS.includes(kind)) {
      const length = kind === 'oneline' ? width : OID_HEX
      const id = commit.oid.slice(0, length),
        parent = (commit.parents[index] ?? '').slice(0, length)
      text = text.replace(id, `${id} (from ${parent})`)
    }
    let gap = text && body && line !== null ? `${line}\n` : ''
    if (!body && text && (emptySummary || isCombined(commit, flags))) gap = '\n'
    blocks.push(text + gap + body)
  })
  const separator = TEMPLATE_KINDS.includes(kind) || TERMINATED_KINDS.includes(kind) ? '' : '\n'
  return blocks.join(separator) || head
}

/**
 * A commit's log entry and its diff against its parents, as `log` and `show`
 * print it. A commit that changes nothing the pathspec names prints nothing at
 * all.
 *
 * @param repo repository to read
 * @param commit the commit to show
 * @param display the invocation's presentation flags
 * @param diff the diff options
 * @param sides its comparisons, as the session sees them
 * @param decor ref labels when the format asked
 * @param emptySummary put a blank line under a header whose diff is empty, as
 *   `show` does for a summary or a combined diff
 * @param parents the parents the header prints, the commit's own when null
 */
export async function commitEntry(
  repo: Repo,
  commit: CommitFacts,
  display: CommitDisplay,
  diff: DiffFlags,
  sides: readonly Side[],
  decor: Decorations | null,
  emptySummary = false,
  parents: readonly string[] | null = null,
): Promise<string> {
  const head = commitHeader(commit, display, repo.abbrev, decor, parents)
  const bodies = await commitOutput(repo, commit, diff, sides)
  return joinOutput(commit, head, bodies, display.pretty.kind, repo.abbrev, diff, emptySummary)
}
