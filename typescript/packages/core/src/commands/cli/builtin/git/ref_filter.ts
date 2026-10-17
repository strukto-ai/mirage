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

import { compileSpec, expandGitLong } from '../../../spec/compile.ts'
import { GIT_LONG_OPTIONS } from '../../constants.ts'
import type { Context } from '../../../config.ts'
import { HEAD } from './constants.ts'
import {
  GitError,
  MalformedMergeFilterError,
  MalformedObjectError,
  NotACommitError,
} from './errors.ts'
import { peelToCommit } from './history.ts'
import { commitFacts, repoArgs, type Repo } from './repo.ts'
import { COMMIT, TAG, resolveObject, tagObject, unwrapped } from './revparse.ts'

const CONTAINS = '--contains'
const NO_CONTAINS = '--no-contains'
const MERGED = '--merged'
const NO_MERGED = '--no-merged'
const POINTS_AT = '--points-at'
const MARKER = '--'

// The order git names a filter in when a line that deletes holds one.
const LIST_MODE_ORDER = [CONTAINS, NO_CONTAINS, POINTS_AT, MERGED, NO_MERGED]

/** One ref-filter option as the line spelled it, in line order. */
export interface FilterWord {
  /** The option's full long spelling, e.g. `--contains`. */
  readonly option: string
  /** The commit or object it names. */
  readonly value: string
  /**
   * Whether the parser left the value among the operands, which is where a
   * detached value of an optional-value option lands.
   */
  readonly operand: boolean
}

/** The commits and objects a listing is narrowed by, resolved. */
export interface RefFilter {
  readonly contains: readonly string[]
  readonly noContains: readonly string[]
  /** Every commit reachable from a `--merged` commit, null without one. */
  readonly merged: ReadonlySet<string> | null
  /** Every commit reachable from a `--no-merged` commit, null without one. */
  readonly noMerged: ReadonlySet<string> | null
  readonly pointsAt: readonly string[]
}

/**
 * The ref-filter options a line holds, read off its verbatim argv.
 *
 * The four commit filters take the next word as their commit, whatever it
 * looks like, except as the line's last word, where they read HEAD:
 * parse-options' LASTARG_DEFAULT. They are declared with an optional value, so
 * a detached value reached the operands, and this is where it is reattached.
 * Every other option is skipped by the leaf's own spec, so a value that
 * happens to spell a filter (`tag -m --contains`) stays that option's value,
 * and the scan stops at `--` the way the parser does. A long spelling may be a
 * unique prefix (`--cont`), as git's parse-options accepts.
 *
 * @param ctx the line's context, whose `spec` is the leaf that parsed it
 */
export function filterWords(ctx: Context): FilterWord[] {
  if (ctx.spec === undefined) return []
  const cs = compileSpec(ctx.spec)
  const argv = ctx.argv ?? []
  const words: FilterWord[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? ''
    if (token === MARKER) break
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const typed = eq === -1 ? token : token.slice(0, eq)
      const expanded = expandGitLong(GIT_LONG_OPTIONS.get(ctx.spec.name) ?? [], typed)
      const spelling = expanded !== null && 'spelling' in expanded ? expanded.spelling : typed
      const next = argv[i + 1]
      if (LIST_MODE_ORDER.includes(spelling)) {
        if (eq !== -1) {
          words.push({ option: spelling, value: token.slice(eq + 1), operand: false })
        } else if (next !== undefined) {
          i += 1
          const operand = spelling !== POINTS_AT && (next === '-' || !next.startsWith('-'))
          words.push({ option: spelling, value: next, operand })
        } else {
          words.push({ option: spelling, value: HEAD, operand: false })
        }
      } else if (eq === -1 && cs.longValueSpellings.has(spelling)) {
        i += 1
      }
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      for (let j = 1; j < token.length; j += 1) {
        const short = `-${token.charAt(j)}`
        if (cs.valueSpellings.includes(short)) {
          if (j === token.length - 1) i += 1
          break
        }
        if (cs.attachSpellings.includes(short)) break
      }
    }
  }
  return words
}

/**
 * The operands left once the filter values the parser kept are taken out.
 *
 * Only a listing reads what is left, as name patterns, and patterns are
 * alternatives, so which of two equal words goes makes no difference.
 *
 * @param texts the operands as parsed
 * @param words the line's filter options
 */
export function withoutFilterValues(
  texts: readonly string[],
  words: readonly FilterWord[],
): string[] {
  const left = [...texts]
  for (const word of words) {
    if (!word.operand) continue
    const at = left.indexOf(word.value)
    if (at !== -1) left.splice(at, 1)
  }
  return left
}

/**
 * The filter a line that deletes is refused for holding, in git's order.
 *
 * @param words the line's filter options
 */
export function listModeOption(words: readonly FilterWord[]): string | null {
  return LIST_MODE_ORDER.find((option) => words.some((word) => word.option === option)) ?? null
}

/** The object a filter names, or git's refusal for the option naming it. */
async function objectFor(repo: Repo, word: FilterWord): Promise<{ oid: string; type: string }> {
  try {
    if (word.option === POINTS_AT) {
      return (await tagObject(repo, word.value)) ?? (await resolveObject(repo, word.value))
    }
    return await resolveObject(repo, word.value)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    if (word.option === MERGED || word.option === NO_MERGED) {
      throw new MalformedMergeFilterError(word.value)
    }
    throw new MalformedObjectError(word.value, word.option === POINTS_AT)
  }
}

/** The commit a commit filter names, tags peeled. */
async function commitFor(repo: Repo, word: FilterWord): Promise<string> {
  const found = await unwrapped(repo, await objectFor(repo, word), word.value)
  if (found.type === COMMIT) return found.oid
  const reason =
    word.option === MERGED || word.option === NO_MERGED
      ? `option \`${word.option.slice(2)}' must point to a commit`
      : `no such commit ${word.value}`
  throw new NotACommitError(found.oid, found.type, reason)
}

/** Every commit reachable from the given ones, themselves included. */
async function ancestry(repo: Repo, oids: readonly string[]): Promise<Set<string>> {
  const seen = new Set<string>()
  const stack = [...oids]
  for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
    if (seen.has(oid)) continue
    seen.add(oid)
    stack.push(...(await commitFacts(repo, oid)).parents)
  }
  return seen
}

/**
 * Resolve a line's filter options, in line order, null when it holds none.
 *
 * In line order because git resolves each as it parses it, so the first bad
 * name on the line is the one refused.
 *
 * @param repo the opened repository
 * @param words the line's filter options
 */
export async function refFilter(
  repo: Repo,
  words: readonly FilterWord[],
): Promise<RefFilter | null> {
  if (words.length === 0) return null
  const lists = new Map<string, string[]>(
    [CONTAINS, NO_CONTAINS, MERGED, NO_MERGED, POINTS_AT].map((option) => [option, []]),
  )
  for (const word of words) {
    const oid =
      word.option === POINTS_AT ? (await objectFor(repo, word)).oid : await commitFor(repo, word)
    lists.get(word.option)?.push(oid)
  }
  const merged = lists.get(MERGED) ?? []
  const noMerged = lists.get(NO_MERGED) ?? []
  return {
    contains: lists.get(CONTAINS) ?? [],
    noContains: lists.get(NO_CONTAINS) ?? [],
    merged: merged.length > 0 ? await ancestry(repo, merged) : null,
    noMerged: noMerged.length > 0 ? await ancestry(repo, noMerged) : null,
    pointsAt: lists.get(POINTS_AT) ?? [],
  }
}

/**
 * Whether a commit reaches any of the targets, memoised across calls.
 *
 * One memo per target set turns a listing of many refs into one walk of the
 * history they share, which is how git answers `tag --contains` over
 * thousands of tags.
 */
async function reaches(
  repo: Repo,
  tip: string,
  targets: ReadonlySet<string>,
  memo: Map<string, boolean>,
): Promise<boolean> {
  const stack: [string, boolean][] = [[tip, false]]
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [oid, expanded] = top
    if (memo.has(oid)) continue
    if (targets.has(oid)) {
      memo.set(oid, true)
      continue
    }
    const { parents } = await commitFacts(repo, oid)
    if (expanded) {
      memo.set(
        oid,
        parents.some((parent) => memo.get(parent) === true),
      )
      continue
    }
    stack.push([oid, true])
    for (const parent of parents) if (!memo.has(parent)) stack.push([parent, false])
  }
  return memo.get(tip) === true
}

/** Whether a ref points at one of the objects, directly or through its tag. */
async function pointsAt(repo: Repo, oid: string, objects: readonly string[]): Promise<boolean> {
  if (objects.includes(oid)) return true
  // Deprecated upstream for being general, but the general answer is what
  // telling a tag from anything else needs.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const { type } = await git.readObject({ ...repoArgs(repo), oid })
  if (type !== TAG) return false
  return objects.includes((await git.readTag({ ...repoArgs(repo), oid })).tag.object)
}

/**
 * The names of the refs a filter keeps, from `[name, object]` pairs.
 *
 * git's order of tests: `--points-at` on the ref's own object (or the one its
 * tag object points at, one level down), then the commit filters, which drop
 * a ref that peels to no commit at all.
 *
 * @param repo the opened repository
 * @param filter the resolved filter
 * @param refs each candidate ref's name and the object it points at
 */
export async function keptRefs(
  repo: Repo,
  filter: RefFilter,
  refs: readonly (readonly [string, string])[],
): Promise<Set<string>> {
  const kept = new Set<string>()
  const containsTargets = new Set(filter.contains)
  const noContainsTargets = new Set(filter.noContains)
  const containsMemo = new Map<string, boolean>()
  const noContainsMemo = new Map<string, boolean>()
  const byCommit =
    containsTargets.size > 0 ||
    noContainsTargets.size > 0 ||
    filter.merged !== null ||
    filter.noMerged !== null
  for (const [name, oid] of refs) {
    if (filter.pointsAt.length > 0 && !(await pointsAt(repo, oid, filter.pointsAt))) continue
    if (byCommit) {
      const commit = await peelToCommit(repo, oid)
      if (commit === null) continue
      if (
        containsTargets.size > 0 &&
        !(await reaches(repo, commit.oid, containsTargets, containsMemo))
      )
        continue
      if (
        noContainsTargets.size > 0 &&
        (await reaches(repo, commit.oid, noContainsTargets, noContainsMemo))
      )
        continue
      if (filter.merged !== null && !filter.merged.has(commit.oid)) continue
      if (filter.noMerged?.has(commit.oid) === true) continue
    }
    kept.add(name)
  }
  return kept
}
