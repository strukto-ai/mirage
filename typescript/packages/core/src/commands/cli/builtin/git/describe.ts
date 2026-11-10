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

import git from 'isomorphic-git'

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { IOResult } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { headEntries, stagedEntries, workEntries } from './changes.ts'
import { ConfigUsageError, GitError, UsageError } from './errors.ts'
import { abbrevWidth } from './format.ts'
import { readIndex } from './index_file.ts'
import { resolveRef, uniqueAbbreviations } from './ref_list.ts'
import { loadRefs } from './refs.ts'
import { commitFacts, objectType, repoArgs, type Repo } from './repo.ts'
import { resolveCommit, resolveObject } from './revparse.ts'
import { shownEntries } from './seen.ts'
import { opened } from './session.ts'
import type { TreeEntry } from './tree.ts'
import { loneHelp, optionOperand, requireVfs, verbUsage } from './util.ts'

const ENC = new TextEncoder()
const TAG_NAMESPACE = 'refs/tags/'
const BRANCH_NAMESPACE = 'refs/heads/'
const REMOTE_NAMESPACE = 'refs/remotes/'
const REFS_NAMESPACE = 'refs/'
const DEFAULT_CANDIDATES = 10
const DIRTY_MARK = '-dirty'
const ANNOTATED = 2
const LIGHTWEIGHT = 1
const OTHER_REF = 0
const NO_ABBREVIATION = 0

interface Name {
  readonly text: string
  readonly commit: string
  readonly priority: number
  readonly when: number
}

function numberOf(value: FlagValue | undefined, option: string): number | null {
  if (typeof value !== 'string') return null
  if (!/^[0-9]+$/.test(value)) {
    throw new ConfigUsageError(`option \`${option}' expects a numerical value`)
  }
  return Number(value)
}

/** What a ref points at past any tags, and the tag's date when it is annotated. */
async function peeledTag(repo: Repo, oid: string): Promise<[string, boolean, number]> {
  let current = oid
  let annotated = false
  let when = 0
  while ((await objectType(repo, current)) === 'tag') {
    const { tag } = await git.readTag({ ...repoArgs(repo), oid: current })
    if (!annotated) when = tag.tagger.timestamp
    annotated = true
    current = tag.object
  }
  return [current, annotated, when]
}

/** The best name each commit has, as the line's options allow. */
async function namesOf(repo: Repo, fl: FlagView, takeLight: boolean): Promise<Map<string, Name>> {
  const table = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  const everyRef = fl.asBool('all')
  const matches = fl.asList('match')
  const excludes = fl.asList('exclude')
  const chosen = new Map<string, Name>()
  for (const ref of [...table.keys()].sort(compareCodePoints)) {
    let short: string
    if (ref.startsWith(TAG_NAMESPACE)) short = ref.slice(TAG_NAMESPACE.length)
    else if (everyRef && ref.startsWith(BRANCH_NAMESPACE))
      short = ref.slice(BRANCH_NAMESPACE.length)
    else if (everyRef && ref.startsWith(REMOTE_NAMESPACE))
      short = ref.slice(REMOTE_NAMESPACE.length)
    else if (everyRef && ref.startsWith(REFS_NAMESPACE)) short = ref.slice(REFS_NAMESPACE.length)
    else continue
    if (matches.length > 0 && !matches.some((pattern) => fnmatch(short, pattern))) continue
    if (excludes.some((pattern) => fnmatch(short, pattern))) continue
    const [oid] = resolveRef(table, ref)
    if (oid === null) continue
    const [commit, annotated, when] = await peeledTag(repo, oid)
    let priority = OTHER_REF
    if (ref.startsWith(TAG_NAMESPACE)) priority = annotated ? ANNOTATED : LIGHTWEIGHT
    if (priority === LIGHTWEIGHT && !takeLight) continue
    if ((await objectType(repo, commit)) !== 'commit') continue
    const held = chosen.get(commit)
    const better =
      held === undefined ||
      priority > held.priority ||
      (priority === held.priority && when > held.when)
    if (better) {
      chosen.set(commit, {
        text: everyRef ? ref.slice(REFS_NAMESPACE.length) : short,
        commit,
        priority,
        when,
      })
    }
  }
  return chosen
}

async function parentsOf(
  repo: Repo,
  oid: string,
  firstParent: boolean,
): Promise<readonly string[]> {
  const parents = (await commitFacts(repo, oid)).parents
  return firstParent ? parents.slice(0, 1) : parents
}

/** Every commit a walk from one commit reaches, itself included. */
async function reach(repo: Repo, start: string, firstParent: boolean): Promise<Set<string>> {
  const seen = new Set([start])
  const pending = [start]
  while (pending.length > 0) {
    const oid = pending.pop() ?? ''
    for (const parent of await parentsOf(repo, oid, firstParent)) {
      if (!seen.has(parent)) {
        seen.add(parent)
        pending.push(parent)
      }
    }
  }
  return seen
}

/**
 * The name closest to a commit and how many commits lie past it. A newest-first
 * walk gathers up to `limit` names it meets; each is scored by the commits the
 * target has that the name does not reach, and the first with the lowest score
 * is kept.
 */
async function nearest(
  repo: Repo,
  target: string,
  names: ReadonlyMap<string, Name>,
  limit: number,
  firstParent: boolean,
): Promise<[Name, number] | null> {
  const time = async (oid: string): Promise<number> => (await commitFacts(repo, oid)).committerTime
  const queue: [number, string][] = [[-(await time(target)), target]]
  const seen = new Set([target])
  const met: Name[] = []
  while (queue.length > 0 && met.length < Math.max(limit, 1)) {
    queue.sort((a, b) => a[0] - b[0] || compareCodePoints(a[1], b[1]))
    const [, oid] = queue.shift() ?? [0, '']
    const name = names.get(oid)
    if (name !== undefined) met.push(name)
    for (const parent of await parentsOf(repo, oid, firstParent)) {
      if (seen.has(parent)) continue
      seen.add(parent)
      queue.push([-(await time(parent)), parent])
    }
  }
  if (met.length === 0) return null
  const reached = await reach(repo, target, firstParent)
  let best: [Name, number] | null = null
  for (const name of met) {
    const theirs = await reach(repo, name.commit, firstParent)
    let depth = 0
    for (const oid of reached) if (!theirs.has(oid)) depth += 1
    if (best === null || depth < best[1]) best = [name, depth]
  }
  return best
}

async function short(repo: Repo, oid: string, width: number): Promise<string> {
  const unique = await uniqueAbbreviations(repo, new Map([[oid, width]]))
  return oid.slice(0, unique.get(oid) ?? width)
}

/** One commit's description. */
async function described(
  repo: Repo,
  target: string,
  names: ReadonlyMap<string, Name>,
  fl: FlagView,
  width: number,
  lightweight: ReadonlyMap<string, Name>,
): Promise<string> {
  const exact = fl.asBool('exact_match')
  const limit = numberOf(fl.raw('candidates'), 'candidates')
  const candidates = exact ? 0 : (limit ?? DEFAULT_CANDIDATES)
  const firstParent = fl.asBool('first_parent')
  let found: [Name, number] | null
  if (candidates === 0) {
    const name = names.get(target)
    found = name === undefined ? null : [name, 0]
  } else found = await nearest(repo, target, names, candidates, firstParent)
  if (found === null) {
    if (exact || candidates === 0) throw new GitError(`no tag exactly matches '${target}'`)
    if (fl.asBool('always')) return short(repo, target, width === 0 ? target.length : width)
    if (names.size === 0 && lightweight.size === 0)
      throw new GitError('No names found, cannot describe anything.')
    if (
      lightweight.size > 0 &&
      (await nearest(repo, target, lightweight, DEFAULT_CANDIDATES, firstParent)) !== null
    ) {
      throw new GitError(
        `No annotated tags can describe '${target}'.\nHowever, there were unannotated tags: try --tags.`,
      )
    }
    throw new GitError(`No tags can describe '${target}'.\nTry --always, or create some tags.`)
  }
  const [name, depth] = found
  if (width === NO_ABBREVIATION || (depth === 0 && !fl.asBool('long'))) return name.text
  return `${name.text}-${String(depth)}-g${await short(repo, target, width)}`
}

async function isDirty(ctx: Context, fl: FlagView): Promise<boolean> {
  const vfs = requireVfs(ctx)
  const repo = await opened(ctx, fl, true)
  const state = await readIndex(repo, repo.vfs)
  const same = (a: ReadonlyMap<string, TreeEntry>, b: ReadonlyMap<string, TreeEntry>): boolean =>
    a.size === b.size &&
    [...a].every(([path, side]) => {
      const other = b.get(path)
      return other?.oid === side.oid && other.mode === side.mode
    })
  const head = shownEntries(repo, (await headEntries(repo)) ?? new Map())
  const staged = shownEntries(repo, stagedEntries(state))
  if (!same(head, staged)) return true
  return !same(await workEntries(repo, vfs, state), staged)
}

/** `git describe`: name a commit after the nearest tag. */
/** Every description the line asks for. */
async function describeAll(
  repo: Repo,
  revisions: readonly string[],
  fl: FlagView,
  width: number,
): Promise<string[]> {
  const light = fl.asBool('all') || fl.asBool('tags')
  const names = await namesOf(repo, fl, light)
  const lightweight = light ? new Map<string, Name>() : await namesOf(repo, fl, true)
  const lines: string[] = []
  for (const revision of revisions) {
    let found
    try {
      found = await resolveObject(repo, revision)
    } catch (err) {
      if (err instanceof GitError) throw new GitError(`Not a valid object name ${revision}`)
      throw err
    }
    if (found.type === 'tree') throw new GitError(`${revision} is neither a commit nor blob`)
    lines.push(
      await described(repo, await resolveCommit(repo, revision), names, fl, width, lightweight),
    )
  }
  return lines
}

function mark(value: FlagValue | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export async function describe(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  if (optionOperand(ctx, texts, loneHelp(ctx, texts)) !== null) {
    throw new UsageError('', verbUsage(ctx))
  }
  const dirty = fl.raw('dirty')
  const broken = fl.raw('broken')
  const marked = dirty !== undefined || broken !== undefined
  if (marked && texts.length > 0) {
    throw new GitError("option '--dirty' and commit-ishes cannot be used together")
  }
  const abbrev = numberOf(fl.raw('abbrev'), 'abbrev')
  if (abbrev === NO_ABBREVIATION && fl.asBool('long')) {
    throw new GitError("options '--long' and '--abbrev=0' cannot be used together")
  }
  numberOf(fl.raw('candidates'), 'candidates')
  const repo = await opened(ctx, fl)
  const width =
    abbrev === null
      ? repo.abbrev
      : abbrev === NO_ABBREVIATION
        ? NO_ABBREVIATION
        : abbrevWidth(String(abbrev), repo.abbrev)
  const lines = await describeAll(repo, texts.length > 0 ? texts : ['HEAD'], fl, width)
  let suffix = ''
  if (marked && (await isDirty(ctx, fl))) {
    suffix = mark(dirty ?? broken, DIRTY_MARK)
  }
  return [ENC.encode(lines.map((line) => `${line}${suffix}\n`).join('')), new IOResult()]
}
