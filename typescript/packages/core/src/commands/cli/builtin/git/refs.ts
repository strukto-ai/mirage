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

import { compareCodePoints } from '../../../../utils/sort.ts'
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
 * `packed-refs` with one ref's lines removed, null if it held none.
 *
 * A packed ref is two lines rather than one when it is an annotated tag: the tag
 * object's own id, then a `^` line holding the commit it peels to. The peeled
 * line belongs to the ref above it, so dropping a ref drops the `^` line that
 * follows it and nothing else.
 */
export function withoutPacked(text: string, ref: string): string | null {
  const kept: string[] = []
  let dropped = false
  let found = false
  for (const line of text.split('\n')) {
    if (line.startsWith('^')) {
      if (!dropped) kept.push(line)
      continue
    }
    dropped = false
    if (line !== '' && !line.startsWith('#')) {
      const space = line.indexOf(' ')
      if (space !== -1 && line.slice(space + 1).trim() === ref) {
        dropped = true
        found = true
        continue
      }
    }
    kept.push(line)
  }
  return found ? kept.join('\n') : null
}

/**
 * Remove a ref, loose copy and packed copy alike.
 *
 * Both are removed because either alone can be what holds the ref, and removing
 * only the loose one would report a deletion the next read undoes: after
 * `git pack-refs` a ref exists nowhere else, and a force-updated one exists in
 * both, where dropping the loose file would resurrect the older packed value.
 */
export async function deleteRef(dispatch: Dispatch, commondir: string, ref: string): Promise<void> {
  await removeFile(dispatch, under(commondir, ref))
  const path = under(commondir, PACKED_REFS)
  const data = await readOptional(dispatch, path)
  if (data === null) return
  const rewritten = withoutPacked(DEC.decode(data), ref)
  if (rewritten !== null) await writeFile(dispatch, path, ENC.encode(rewritten))
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

export const TAG_PREFIX = 'refs/tags/'

// Every character git forbids anywhere in a ref name, on top of the control
// characters: the shell metacharacters that would make a name unusable as a
// revision, and the backslash.
const FORBIDDEN_IN_REF = new Set([' ', '~', '^', ':', '?', '*', '[', '\\'])
const LOCK_SUFFIX = '.lock'

/**
 * The existing ref that stops a new one from being written.
 *
 * A ref is a path, so two of them cannot coexist when one spells a directory
 * the other spells a file: with `refs/tags/foo` already there,
 * `refs/tags/foo/bar` has no directory to live in, and with `refs/tags/foo/bar`
 * there, `refs/tags/foo` has a directory standing on its name. git refuses both
 * and names the ref already written; a repository can only ever hold one of the
 * two shapes, so the two searches cannot both answer.
 *
 * Nothing below git's own storage can be relied on to say so. A disk mount
 * raises whatever its host filesystem raises, which reaches the user as neither
 * git's wording nor git's exit code, and a prefix store takes both keys happily
 * and leaves a ref the loose-ref walk cannot find.
 *
 * @param known every ref the repository holds
 * @param ref the full ref name about to be written
 */
export function blockingRef(known: ReadonlySet<string>, ref: string): string | null {
  const parts = ref.split('/')
  for (let depth = 1; depth < parts.length; depth += 1) {
    const above = parts.slice(0, depth).join('/')
    if (known.has(above)) return above
  }
  const below = `${ref}/`
  const found = [...known].filter((name) => name.startsWith(below)).sort(compareCodePoints)
  return found[0] ?? null
}

/**
 * Whether a name passes git's ref rules (`git check-ref-format`).
 *
 * The rules, in git's own order: no component may start with `.` or end with
 * `.lock`; `..` may not appear; no control character, space or shell
 * metacharacter; no leading, trailing or doubled `/`; no trailing `.`; and no
 * `@{`. Empty is refused too. A bare `@` is refused only as a whole ref, and a
 * name here always sits below `refs/`, so it passes. Pinned against git 2.50.1.
 *
 * @param name the name below `refs/heads/` or `refs/tags/`
 */
export function validRefName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.endsWith('/')) return false
  if (name.includes('//') || name.includes('..') || name.includes('@{') || name.endsWith('.')) {
    return false
  }
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || FORBIDDEN_IN_REF.has(ch)) return false
  }
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith(LOCK_SUFFIX))
}
