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

import { foldAscii } from '../../../../utils/posix.ts'
import git from 'isomorphic-git'

import { getOpcodes } from '../../../builtin/diff_format.ts'
import { DiffOpTag } from '../../../builtin/diff_types.ts'
import { lines } from './patch.ts'
import { repoArgs, type Repo } from './repo.ts'
import { BINARY_SNIFF } from './summary.ts'
import { treeEntries } from './tree.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

/** A blob's bytes, empty for a side that does not exist or is no blob. */
async function blob(repo: Repo, oid: string | null): Promise<Uint8Array> {
  if (oid === null) return new Uint8Array()
  try {
    return (await git.readBlob({ ...repoArgs(repo), oid })).blob
  } catch {
    return new Uint8Array()
  }
}

/**
 * The first match at or after `start` inside one line, as glibc's regexec finds
 * it under REG_NEWLINE: `^` holds after each newline past `start`, and at
 * `start` itself only while `bol`. `pattern` carries the `g` flag.
 */
function matchFrom(
  text: string,
  pattern: RegExp,
  start: number,
  bol: boolean,
): [number, number] | null {
  let at = start
  for (;;) {
    const begin = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1
    const newline = text.indexOf('\n', at)
    const end = newline < 0 ? text.length : newline
    const resumed = at === start && at === begin && !bol
    pattern.lastIndex = resumed ? 1 : at - begin
    const found = pattern.exec(resumed ? `\0${text.slice(begin, end)}` : text.slice(begin, end))
    if (found !== null) {
      const shift = resumed ? begin - 1 : begin
      return [found.index + shift, found.index + found[0].length + shift]
    }
    if (end === text.length) return null
    at = end + 1
  }
}

/**
 * How many times a pattern matches a blob, git's `contains` under
 * `--pickaxe-regex`: each search resumes where the last match ended, a step
 * further after an empty one, and `^` never holds where it resumes.
 */
export function contains(text: string, needle: RegExp): number {
  const pattern = new RegExp(needle.source, needle.flags.replace('g', '') + 'g')
  let count = 0
  let start = 0
  while (start < text.length) {
    const found = matchFrom(text, pattern, start, count === 0)
    if (found === null) break
    count += 1
    start = found[1] + (found[0] === found[1] && found[1] < text.length ? 1 : 0)
  }
  return count
}

/**
 * How many times a string appears in one blob, or a pattern matches it as git
 * counts under `--pickaxe-regex`.
 */
async function occurrences(
  repo: Repo,
  oid: string | null,
  needle: string | RegExp,
  ignoreCase: boolean,
): Promise<number> {
  const data = await blob(repo, oid)
  if (needle instanceof RegExp) return contains(DEC.decode(data), needle)
  const text = ignoreCase ? foldAscii(DEC.decode(data)) : DEC.decode(data)
  if (needle === '') return 0
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * The old and new blob ids of every path a commit changed against its first
 * parent, or against nothing for a root commit.
 */
async function changes(
  repo: Repo,
  oid: string,
  parents: readonly string[],
): Promise<[string | null, string | null][]> {
  const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
  const after = await treeEntries(repo, commit.tree)
  const first = parents[0]
  let before = new Map<string, { oid: string; mode: string }>()
  if (first !== undefined) {
    const parent = await git.readCommit({ ...repoArgs(repo), oid: first })
    before = await treeEntries(repo, parent.commit.tree)
  }
  const out: [string | null, string | null][] = []
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path)?.oid ?? null
    const now = after.get(path)?.oid ?? null
    if (old !== now) out.push([old, now])
  }
  return out
}

/**
 * Whether a commit's diff adds or removes a line the pattern matches: git's
 * `-G`. The lines are the ones `git log -p` prints with a `+` or `-`, from the
 * same line diff; a binary side keeps its path out, as git does without
 * `--text`.
 */
export async function greps(
  repo: Repo,
  oid: string,
  parents: readonly string[],
  pattern: RegExp,
): Promise<boolean> {
  for (const [oldOid, newOid] of await changes(repo, oid, parents)) {
    const old = await blob(repo, oldOid)
    const now = await blob(repo, newOid)
    if ([old, now].some((data) => data.subarray(0, BINARY_SNIFF).includes(0))) continue
    const before = lines(old)
    const after = lines(now)
    for (const [tag, i1, i2, j1, j2] of getOpcodes(before, after)) {
      if (tag === DiffOpTag.EQUAL) continue
      for (const line of [...before.slice(i1, i2), ...after.slice(j1, j2)]) {
        if (pattern.test(line.endsWith('\n') ? line.slice(0, -1) : line)) return true
      }
    }
  }
  return false
}

/**
 * Whether a commit changed the number of occurrences of a string.
 *
 * This is git's `-S` (pickaxe), and it is deliberately not a grep: a commit that
 * merely moves a line containing the string does not change how many times the
 * string appears, so it is not reported. The commit that *introduced* the string
 * is, which is what makes `-S <name> --reverse` answer "where did this come
 * from".
 *
 * Compared against the first parent, or against nothing for a root commit, so
 * the objects a root commit adds all count as introduced. `-i` counts without
 * regard to ASCII case; under `--pickaxe-regex` the needle is a compiled
 * pattern, which carries its own case folding.
 */
export async function touches(
  repo: Repo,
  oid: string,
  parents: readonly string[],
  needle: string | RegExp,
  ignoreCase = false,
): Promise<boolean> {
  const wanted = ignoreCase && typeof needle === 'string' ? foldAscii(needle) : needle
  for (const [old, now] of await changes(repo, oid, parents)) {
    if (
      (await occurrences(repo, old, wanted, ignoreCase)) !==
      (await occurrences(repo, now, wanted, ignoreCase))
    ) {
      return true
    }
  }
  return false
}
