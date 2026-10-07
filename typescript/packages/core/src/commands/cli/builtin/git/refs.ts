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

import type { PathSpec } from '../../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import {
  basename,
  isDirectory,
  readFile,
  readNames,
  readOptional,
  removeFile,
  writeFile,
} from './io.ts'

import type { Dispatch, HeadRef, Refspec, SymbolicEnd } from './types.ts'

const HEAD_FILE = 'HEAD'
const PACKED_REFS = 'packed-refs'
const REFS_DIR = 'refs'
const MAX_SYMREF_DEPTH = 5
const SAFE_ONE_LEVEL = /^[A-Z_]+$/
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
export async function readHead(dispatch: Dispatch, gitdir: PathSpec): Promise<HeadRef> {
  const text = DEC.decode(await readFile(dispatch, gitdir.join(HEAD_FILE))).trim()
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
  root: PathSpec,
  prefix: string,
  refs: Map<string, string>,
): Promise<void> {
  for (const entry of await readNames(dispatch, root)) {
    const name = basename(entry)
    if (name === '') continue
    const child = root.join(name)
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
  commondir: PathSpec,
  ref: string,
  sha: string,
): Promise<void> {
  await writeFile(dispatch, commondir.join(ref), ENC.encode(`${sha}\n`))
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
export async function deleteRef(
  dispatch: Dispatch,
  commondir: PathSpec,
  ref: string,
): Promise<void> {
  await removeFile(dispatch, commondir.join(ref))
  const path = commondir.join(PACKED_REFS)
  const data = await readOptional(dispatch, path)
  if (data === null) return
  const rewritten = withoutPacked(DEC.decode(data), ref)
  if (rewritten !== null) await writeFile(dispatch, path, ENC.encode(rewritten))
}

/** Point HEAD at a branch, symbolically. */
export async function setHead(dispatch: Dispatch, gitdir: PathSpec, ref: string): Promise<void> {
  await writeFile(dispatch, gitdir.join(HEAD_FILE), ENC.encode(`${SYMREF_PREFIX}${ref}\n`))
}

/** Point HEAD straight at a commit, detaching it from any branch. */
export async function detachHead(dispatch: Dispatch, gitdir: PathSpec, sha: string): Promise<void> {
  await writeFile(dispatch, gitdir.join(HEAD_FILE), ENC.encode(`${sha}\n`))
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
  gitdir: PathSpec,
  commondir: PathSpec | null = null,
): Promise<Map<string, string>> {
  const shared = commondir ?? gitdir
  const refs = new Map<string, string>()
  const packed = await readOptional(dispatch, shared.join(PACKED_REFS))
  if (packed !== null) {
    for (const [name, sha] of parsePackedRefs(packed)) refs.set(name, sha)
  }
  await walkLooseRefs(dispatch, shared.join(REFS_DIR), REFS_DIR, refs)
  if (gitdir.virtual !== shared.virtual) {
    await walkLooseRefs(dispatch, gitdir.join(REFS_DIR), REFS_DIR, refs)
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

/**
 * Whether git's ref rules take a whole ref name, one level allowed
 * (`check_refname_format` with `REFNAME_ALLOW_ONELEVEL`): a bare `@` is the one
 * name they refuse whole that they take below `refs/`.
 *
 * @param name the full ref name
 */
export function wholeRefName(name: string): boolean {
  return name !== '@' && validRefName(name)
}

/**
 * A ref's raw value, an object id or `ref: <target>`, null when there is none.
 *
 * Read from the ref table, or for a one-level name outside it (`ORIG_HEAD` and
 * its kin) from the checkout's git directory, which is where git keeps them.
 *
 * @param dispatch workspace op dispatcher
 * @param gitdir this checkout's git directory
 * @param table every ref, as loadRefs reads them
 * @param name the full ref name
 */
export async function rawRef(
  dispatch: Dispatch,
  gitdir: PathSpec,
  table: ReadonlyMap<string, string>,
  name: string,
): Promise<string | null> {
  const known = table.get(name)
  if (known !== undefined) return known
  if (name.startsWith(`${REFS_DIR}/`)) return null
  const data = await readOptional(dispatch, gitdir.join(name))
  return data === null ? null : DEC.decode(data).trim()
}

/**
 * Follow a ref the way `refs_resolve_ref_unsafe` does without reading.
 *
 * One hop when `recurse` is off, otherwise to the end of the chain, which may
 * name a ref that does not exist yet (an unborn branch). Null where git finds
 * no such ref: a name its rules refuse, or a chain more than five deep. Pinned
 * against git 2.47.3.
 *
 * @param dispatch workspace op dispatcher
 * @param gitdir this checkout's git directory
 * @param table every ref, as loadRefs reads them
 * @param name the full ref name to start from
 * @param recurse follow every hop rather than the first
 */
export async function resolveSymbolic(
  dispatch: Dispatch,
  gitdir: PathSpec,
  table: ReadonlyMap<string, string>,
  name: string,
  recurse: boolean,
): Promise<SymbolicEnd | null> {
  if (!wholeRefName(name)) return null
  let current = name
  let symbolic = false
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
    const raw = await rawRef(dispatch, gitdir, table, current)
    if (!raw?.startsWith(SYMREF_PREFIX)) return { name: current, symbolic }
    symbolic = true
    current = raw.slice(SYMREF_PREFIX.length).trim()
    if (!recurse) return { name: current, symbolic }
    if (!wholeRefName(current)) return null
  }
  return null
}

/**
 * Whether git lets a ref transaction write a name it has no object for
 * (`refname_is_safe`): below `refs/`, a path with no empty, `.` or `..`
 * component; anywhere else, capitals and underscores only, which is HEAD and
 * its kin. Pinned against git 2.47.3.
 *
 * @param name the full ref name about to be written
 */
export function safeRefName(name: string): boolean {
  if (name.startsWith(`${REFS_DIR}/`)) {
    return name
      .slice(REFS_DIR.length + 1)
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  }
  return SAFE_ONE_LEVEL.test(name)
}

/** Split a refspec into its source, destination and force flag. */
export function parseRefspec(text: string): Refspec {
  const force = text.startsWith('+')
  const body = force ? text.slice(1) : text
  const colon = body.indexOf(':')
  const src = colon < 0 ? body : body.slice(0, colon)
  const dst = colon < 0 ? '' : body.slice(colon + 1)
  return { src, dst: dst || null, force }
}

/** The local ref a refspec maps a remote ref to, null when unmatched. */
export function mapped(spec: Refspec, name: string): string | null {
  if (!spec.src.includes('*')) return name === spec.src ? (spec.dst ?? '') : null
  const star = spec.src.indexOf('*')
  const head = spec.src.slice(0, star)
  const tail = spec.src.slice(star + 1)
  if (name.length < head.length + tail.length || !name.startsWith(head) || !name.endsWith(tail))
    return null
  const middle = name.slice(head.length, name.length - tail.length)
  if (spec.dst === null) return ''
  const at = spec.dst.indexOf('*')
  return at < 0 ? spec.dst : `${spec.dst.slice(0, at)}${middle}${spec.dst.slice(at + 1)}`
}
