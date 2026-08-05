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

import { AmbiguousArgumentError } from './errors.ts'
import { repoArgs, type Repo } from './repo.ts'
import type { AncestryStep } from './types.ts'

const HEAD = 'HEAD'
const ANCESTOR = '~'
const PARENT = '^'
const SUFFIXES = [ANCESTOR, PARENT]

/**
 * Split a revision into its base and its ancestry suffixes.
 *
 * `HEAD~2^2` is a base plus two steps. Splitting on the first `~` or `^` is safe
 * because git forbids both characters in ref names, so neither can belong to the
 * base.
 *
 * @param revision revision as the user spelled it
 */
function splitRevision(revision: string): [string, AncestryStep[]] {
  let index = revision.length
  for (let i = 0; i < revision.length; i++) {
    if (SUFFIXES.includes(revision.charAt(i))) {
      index = i
      break
    }
  }
  const base = revision.slice(0, index)
  const rest = revision.slice(index)
  const steps: AncestryStep[] = []
  let position = 0
  while (position < rest.length) {
    const kind = rest.charAt(position)
    position += 1
    let digits = ''
    while (position < rest.length && /[0-9]/.test(rest.charAt(position))) {
      digits += rest.charAt(position)
      position += 1
    }
    steps.push({
      firstParent: kind === ANCESTOR,
      count: digits === '' ? 1 : Number.parseInt(digits, 10),
    })
  }
  return [base === '' ? HEAD : base, steps]
}

/** Load one commit's parents by object id, or report the revision as unknown. */
async function parentsOf(repo: Repo, oid: string, revision: string): Promise<string[]> {
  try {
    const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
    return [...commit.parent]
  } catch {
    throw new AmbiguousArgumentError(revision)
  }
}

/**
 * Apply one ancestry suffix to a commit.
 *
 * `~n` walks n generations along first parents; `^n` takes the n-th parent of
 * this commit, and `^0` is the commit itself (git's way of spelling "the commit
 * a tag points at").
 */
async function applyStep(
  repo: Repo,
  oid: string,
  step: AncestryStep,
  revision: string,
): Promise<string> {
  let current = oid
  if (step.firstParent) {
    for (let i = 0; i < step.count; i++) {
      const parents = await parentsOf(repo, current, revision)
      const first = parents[0]
      if (first === undefined) throw new AmbiguousArgumentError(revision)
      current = first
    }
    return current
  }
  if (step.count === 0) return current
  const parents = await parentsOf(repo, current, revision)
  const picked = parents[step.count - 1]
  if (picked === undefined) throw new AmbiguousArgumentError(revision)
  return picked
}

/**
 * Resolve a revision to a commit id, ancestry suffixes included.
 *
 * isomorphic-git resolves refs, full ids and unambiguous short ids, and peels a
 * tag; it knows nothing about `~` and `^`, which are applied here on top of
 * whatever its own parser returns.
 *
 * @param repo repository to resolve against
 * @param revision revision as the user spelled it
 */
export async function resolveCommit(repo: Repo, revision: string): Promise<string> {
  const [base, steps] = splitRevision(revision)
  let oid: string
  try {
    oid = await git.resolveRef({ ...repoArgs(repo), ref: base })
  } catch {
    try {
      oid = await git.expandOid({ ...repoArgs(repo), oid: base })
    } catch {
      throw new AmbiguousArgumentError(revision)
    }
  }
  // A tag names a tag object, not the commit under it; peel until it is one.
  for (;;) {
    let type: string
    try {
      // Deprecated upstream for being general, but the general answer is
      // what peeling needs: which of commit/tag/tree/blob this id names,
      // without reading it as each in turn until one does not throw.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      type = (await git.readObject({ ...repoArgs(repo), oid })).type
    } catch {
      throw new AmbiguousArgumentError(revision)
    }
    if (type === 'commit') break
    if (type !== 'tag') throw new AmbiguousArgumentError(revision)
    oid = (await git.readTag({ ...repoArgs(repo), oid })).tag.object
  }
  for (const step of steps) {
    oid = await applyStep(repo, oid, step, revision)
  }
  return oid
}
