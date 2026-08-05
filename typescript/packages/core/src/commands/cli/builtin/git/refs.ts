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

import { basename } from './path.ts'
import {
  isDirectory,
  readFile,
  readNames,
  readOptional,
  removeFile,
  under,
  writeFile,
} from './io.ts'
import type { Dispatch, HeadRef } from './types.ts'

const HEAD_FILE = 'HEAD'
const PACKED_REFS = 'packed-refs'
const REFS_DIR = 'refs'
export const SYMREF_PREFIX = 'ref: '
export const BRANCH_PREFIX = 'refs/heads/'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

/**
 * Resolve `.git/HEAD` to a branch name or a detached commit.
 *
 * HEAD holds either a symbolic ref (`ref: refs/heads/main`) or a raw object id
 * when the checkout is detached. A ref outside `refs/heads` keeps its full name,
 * which is what git shows for a checked-out tag or remote-tracking ref.
 */
export async function readHead(dispatch: Dispatch, gitdir: string): Promise<HeadRef> {
  const text = DEC.decode(await readFile(dispatch, under(gitdir, HEAD_FILE))).trim()
  if (!text.startsWith(SYMREF_PREFIX)) {
    return { branch: null, ref: null, commit: text === '' ? null : text }
  }
  const ref = text.slice(SYMREF_PREFIX.length).trim()
  const branch = ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref
  return { branch, ref, commit: null }
}

/**
 * Collect loose refs under one directory into the ref table.
 *
 * Ref names nest arbitrarily (`refs/heads/feat/git-cli`,
 * `refs/remotes/origin/main`), so the walk recurses rather than listing one
 * level.
 */
async function walkLooseRefs(
  dispatch: Dispatch,
  root: string,
  prefix: string,
  refs: Map<string, string>,
): Promise<void> {
  for (const entry of await readNames(dispatch, root)) {
    const name = basename(entry)
    if (name === '') continue
    const child = under(root, name)
    if (await isDirectory(dispatch, child)) {
      await walkLooseRefs(dispatch, child, `${prefix}/${name}`, refs)
      continue
    }
    const data = await readOptional(dispatch, child)
    if (data === null) continue
    const value = DEC.decode(data).trim()
    if (value !== '') refs.set(`${prefix}/${name}`, value)
  }
}

/**
 * Point one ref at an object id, as a loose ref file.
 *
 * Always written loose, never into `packed-refs`: git does the same for any ref
 * it updates, and a loose file takes precedence over the packed copy, so a
 * branch that was packed is correctly overridden rather than duplicated.
 *
 * Refs live in the common directory, so a branch made from a linked worktree is
 * visible to the repository it was cut from, which is what makes `git worktree`
 * share branches at all.
 */
export async function writeRef(
  dispatch: Dispatch,
  commondir: string,
  ref: string,
  sha: string,
): Promise<void> {
  await writeFile(dispatch, under(commondir, ref), ENC.encode(`${sha}\n`))
}

/**
 * Remove a loose ref file.
 *
 * Only the loose copy is removed. A ref that also sits in `packed-refs` would
 * come back, which is a real gap rather than a silent one: `branch -d` refuses
 * unless the loose file is what actually holds the branch.
 */
export async function deleteRef(dispatch: Dispatch, commondir: string, ref: string): Promise<void> {
  await removeFile(dispatch, under(commondir, ref))
}

/** Point HEAD at a branch, symbolically. */
export async function setHead(dispatch: Dispatch, gitdir: string, ref: string): Promise<void> {
  await writeFile(dispatch, under(gitdir, HEAD_FILE), ENC.encode(`${SYMREF_PREFIX}${ref}\n`))
}

/** Point HEAD straight at a commit, detaching it from any branch. */
export async function detachHead(dispatch: Dispatch, gitdir: string, sha: string): Promise<void> {
  await writeFile(dispatch, under(gitdir, HEAD_FILE), ENC.encode(`${sha}\n`))
}

/**
 * Read `packed-refs`, discarding the peeled lines.
 *
 * `packed-refs` records an annotated tag twice: the tag object's own id, then a
 * `^` line holding the commit it points at. The peeled id is a lookup shortcut,
 * not a separate ref, so it is read and discarded; resolving a tag loads the tag
 * object and follows it. A reader that treats a peeled line as a ref would
 * publish a second entry under the same name.
 */
function parsePackedRefs(data: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>()
  for (const line of DEC.decode(data).split('\n')) {
    const text = line.trim()
    if (text === '' || text.startsWith('#') || text.startsWith('^')) continue
    const space = text.indexOf(' ')
    if (space === -1) continue
    refs.set(text.slice(space + 1).trim(), text.slice(0, space))
  }
  return refs
}

/**
 * Read every ref a repository publishes, packed and loose.
 *
 * Both sources are needed and neither is optional: a freshly cloned repository
 * keeps `refs/remotes/origin/main` only in `packed-refs`, while a branch
 * committed to since the last pack exists only as a loose file. Loose wins on a
 * collision, which is git's own precedence.
 *
 * Refs come from two directories when the two differ. A linked worktree shares
 * its branches with the repository it was cut from and keeps only its own HEAD
 * and per-checkout refs (`refs/bisect`, `refs/worktree`), so the shared table is
 * read first and the worktree's own overrides it, then HEAD last of all.
 *
 * @param dispatch workspace op dispatcher
 * @param gitdir this checkout's git directory, which owns HEAD
 * @param commondir the shared git directory, which owns the branches; null means
 *   it is the same directory, which is every ordinary checkout
 */
export async function loadRefs(
  dispatch: Dispatch,
  gitdir: string,
  commondir: string | null = null,
): Promise<Map<string, string>> {
  const shared = commondir ?? gitdir
  const refs = new Map<string, string>()
  const packed = await readOptional(dispatch, under(shared, PACKED_REFS))
  if (packed !== null) {
    for (const [name, sha] of parsePackedRefs(packed)) refs.set(name, sha)
  }
  await walkLooseRefs(dispatch, under(shared, REFS_DIR), REFS_DIR, refs)
  if (gitdir !== shared) {
    await walkLooseRefs(dispatch, under(gitdir, REFS_DIR), REFS_DIR, refs)
  }
  const head = await readHead(dispatch, gitdir)
  if (head.ref !== null) refs.set(HEAD_FILE, `${SYMREF_PREFIX}${head.ref}`)
  else if (head.commit !== null) refs.set(HEAD_FILE, head.commit)
  return refs
}
