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

import { resolvePath } from '../../../utils/path.ts'
import { IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec, wordText } from '../../../types.ts'
import { CycleError, gnuBasename, gnuDirname, norm } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { MountNotAllowedError } from '../../../context/session_context.ts'
import { PolicyDenied } from '../../../policy/index.ts'
import type { StatOverlay } from '../../../ops/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'

// Commands whose path operands name the link itself (lstat semantics):
// rm/mv mutate the link entry, ln/readlink inspect it, rmdir must not
// descend through it. Everything else follows links before dispatch,
// mirroring open(2).

function abs(arg: string | PathSpec, cwd: string): string {
  if (arg instanceof PathSpec) return arg.virtual
  return resolvePath(arg, cwd)
}

// Path of `target` relative to directory `startDir` (both absolute posix),
// the transform behind `ln -r` (GNU --relative).
function posixRelative(target: string, startDir: string): string {
  const t = target.split('/').filter(Boolean)
  const s = startDir.split('/').filter(Boolean)
  let i = 0
  while (i < t.length && i < s.length && t[i] === s[i]) i += 1
  const parts = [...s.slice(i).map(() => '..'), ...t.slice(i)]
  return parts.length > 0 ? parts.join('/') : '.'
}

function allKnown(chars: string, known: string): boolean {
  for (const c of chars) if (!known.includes(c)) return false
  return true
}

function splitFlags(
  args: (string | PathSpec)[],
  known: string,
): [Set<string>, (string | PathSpec)[]] {
  const flags = new Set<string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  for (const arg of args) {
    const s = arg instanceof PathSpec ? arg.virtual : arg
    if (parsing && s === '--') {
      parsing = false
      continue
    }
    if (parsing && s !== '-' && s.length >= 2 && s.startsWith('-') && allKnown(s.slice(1), known)) {
      for (const c of s.slice(1)) flags.add(c)
      continue
    }
    parsing = false
    operands.push(arg)
  }
  return [flags, operands]
}

export function linkFlags(args: (string | PathSpec)[], known: string): Set<string> {
  return splitFlags(args, known)[0]
}

function errorResult(command: string, message: string): Result {
  const err = new TextEncoder().encode(message)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command, exitCode: 1, stderr: err }),
  ]
}

// ln -s TARGET LINK: create a namespace symbolic link. Flags: -f overwrite
// an existing link, -v report the link, -r store the target relative to the
// link's directory (GNU --relative). -n (--no-dereference) and -T
// (--no-target-directory) are accepted no-ops: a namespace link name is
// never dereferenced nor treated as a directory to descend into.
export async function handleLn(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: Session,
  args: (string | PathSpec)[],
): Promise<Result> {
  const [flags, operands] = splitFlags(args, 'sfnvrT')
  const targetArg = operands[0]
  const linkArg = operands[1]
  if (targetArg === undefined || linkArg === undefined) {
    return errorResult('ln', 'ln: missing file operand\n')
  }
  // GNU: with more than two operands the last must be a directory;
  // namespace links never name directories, so this is always an error
  // (an expanded multi-match glob source lands here).
  if (operands.length > 2) {
    const last = operands[operands.length - 1]
    return errorResult('ln', `ln: target '${wordText(last ?? '')}': Not a directory\n`)
  }
  const linkAbs = abs(linkArg, session.cwd)
  let targetTyped = wordText(targetArg)
  if (flags.has('r')) {
    // --relative: rewrite the target relative to the link's own directory
    // so the link stays valid addressed from anywhere. GNU canonicalizes
    // existing symlink components of both ends first, so an aliased
    // directory resolves to its real path (the link survives the alias
    // being moved/removed); fall back to lexical on a loop.
    let linkDir = gnuDirname(linkAbs)
    let targetAbs = abs(targetArg, session.cwd)
    try {
      targetAbs = namespace.follow(targetAbs)
      linkDir = namespace.follow(linkDir)
    } catch (err) {
      if (!(err instanceof CycleError)) throw err
    }
    targetTyped = posixRelative(targetAbs, linkDir)
  }
  const exists = namespace.isLink(linkAbs) && !flags.has('f')
  if (namespace.isMountRoot(linkAbs) || exists) {
    return errorResult(
      'ln',
      `ln: failed to create symbolic link '${wordText(linkArg)}': File exists\n`,
    )
  }
  // The write itself is a dispatch op, so session grants and admission
  // policies fire at the door; a refusal renders in ln's own words.
  try {
    await dispatch('symlink', PathSpec.fromStrPath(linkAbs), [], { target: targetTyped })
  } catch (err) {
    if (err instanceof PolicyDenied || err instanceof MountNotAllowedError) {
      return errorResult(
        'ln',
        `ln: failed to create symbolic link '${wordText(linkArg)}': Permission denied\n`,
      )
    }
    throw err
  }
  let out: Uint8Array | null = null
  if (flags.has('v')) {
    out = new TextEncoder().encode(`'${wordText(linkArg)}' -> '${targetTyped}'\n`)
  }
  return [out, new IOResult(), new ExecutionNode({ command: 'ln', exitCode: 0 })]
}

// Rewrite path operands through the symlink table (open(2) semantics).
// A rewritten spec keeps the user-typed form in `rawPath` so error messages
// still name the operand as typed; the mount re-stamps `resourcePath` at
// dispatch. Throws CycleError (carrying the typed operand) on ELOOP.
export function followPaths(
  namespace: Namespace,
  items: (string | PathSpec)[],
): (string | PathSpec)[] {
  const out: (string | PathSpec)[] = []
  for (const item of items) {
    if (!(item instanceof PathSpec)) {
      out.push(item)
      continue
    }
    let virtual: string
    try {
      virtual = namespace.follow(item.virtual)
    } catch (err) {
      if (err instanceof CycleError) throw new CycleError(item.rawPath)
      throw err
    }
    if (virtual === item.virtual) {
      out.push(item)
      continue
    }
    out.push(
      new PathSpec({
        virtual,
        directory: virtual.slice(0, virtual.lastIndexOf('/') + 1) || '/',
        resourcePath: '',
        pattern: item.pattern,
        resolved: item.resolved,
        rawPath: item.rawPath,
      }),
    )
  }
  return out
}

// Unlink and drop `rm` operands that are symlinks. GNU rm removes the link
// itself and never follows it; a dangling link removes fine.
export async function stripLinkOperands(
  namespace: Namespace,
  items: (string | PathSpec)[],
): Promise<[(string | PathSpec)[], number]> {
  let removed = 0
  const kept: (string | PathSpec)[] = []
  for (const item of items) {
    if (item instanceof PathSpec && namespace.isLink(item.virtual)) {
      await namespace.unlink(item.virtual)
      removed += 1
      continue
    }
    kept.push(item)
  }
  return [kept, removed]
}

async function statOrNull(dispatch: DispatchFn, path: PathSpec): Promise<FileStat | null> {
  // A missing destination is an expected mv case (plain rename), not an
  // error to surface.
  try {
    const [stat] = await dispatch('stat', path)
    return stat instanceof FileStat ? stat : null
  } catch {
    return null
  }
}

export interface PreparedMv {
  items: (string | PathSpec)[]
  postUnlink: string | null
  postRename: [string, string] | null
  early: Result | null
}

// Adjust a two-operand `mv` for node-meta operands. A link source renames
// the link entry itself. A destination that is (a link to) a directory
// receives the move inside it (rename(2) preceded by mv's dst stat); any
// other destination is replaced, so its node entry, link or overlay attrs
// alike, drops once the backend move succeeds. A plain source that carries
// overlay attributes has its meta travel with the file once the backend
// move succeeds.
export async function prepareMv(
  namespace: Namespace,
  dispatch: DispatchFn,
  items: (string | PathSpec)[],
): Promise<PreparedMv> {
  const paths = items.filter((p): p is PathSpec => p instanceof PathSpec)
  const src = paths[0]
  const dst = paths[1]
  if (paths.length !== 2 || src === undefined || dst === undefined) {
    return { items, postUnlink: null, postRename: null, early: null }
  }

  // Where the move lands: inside a directory destination (followed, so
  // node-meta keys line up with the followed paths stat merges on), else
  // the destination itself, replaced like rename(2).
  const followed = namespace.follow(dst.virtual)
  const stat = await statOrNull(dispatch, PathSpec.fromStrPath(followed))
  const intoDir = stat !== null && stat.type === FileType.DIRECTORY
  let targetDst = dst.virtual
  if (intoDir) {
    const name = src.virtual.slice(src.virtual.lastIndexOf('/') + 1)
    targetDst = rstripSlash(followed) + '/' + name
  }

  if (namespace.isLink(src.virtual)) {
    await namespace.unlink(targetDst)
    await namespace.rename(src.virtual, targetDst)
    const early: Result = [null, new IOResult(), new ExecutionNode({ command: 'mv', exitCode: 0 })]
    return { items, postUnlink: null, postRename: null, early }
  }

  let postRename: [string, string] | null = null
  if (namespace.metaFor(src.virtual) !== null) {
    postRename = [src.virtual, targetDst]
  }

  const rewritten = intoDir && namespace.isLink(dst.virtual) ? followPaths(namespace, items) : items
  return { items: rewritten, postUnlink: targetDst, postRename, early: null }
}

// What an existence probe reads as "nothing here": the path is absent, or
// a component of it is not traversable. Deliberately narrower than a walk's
// tolerance, because a permission or missing-capability error is not
// absence, and mapping it to one would report a path that exists as
// missing. Mirrors python MISS_ERRORS.
function isMissError(exc: unknown): boolean {
  const code = (exc as { code?: string }).code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return true
  const msg = exc instanceof Error ? exc.message : String(exc)
  return /not found|no such file|not a directory|is a directory/i.test(msg)
}

// What a path is, asked on both channels a backend can answer on.
//
// A point lookup alone cannot decide. On a prefix store a directory is not
// an object, it is the set of keys under it, so stat misses what readdir
// would list. Absence therefore takes *both* channels coming back empty,
// which is the only evidence that nothing is there.
//
// The listing has to be non-empty to count: those stores answer a missing
// path with [] rather than raising, and cannot hold an empty directory
// anyway (one with no keys under it does not exist). Measured across every
// integ target: an implicit directory answers here, a missing path does not.
export async function resolvePathStat(
  dispatch: DispatchFn,
  path: PathSpec,
): Promise<FileStat | null> {
  let stat: FileStat | null = null
  try {
    const [s] = await dispatch('stat', path)
    stat = s as FileStat | null
  } catch (exc) {
    if (!isMissError(exc)) throw exc
  }
  if (stat !== null) return stat
  let entries: unknown
  try {
    const [raw] = await dispatch('readdir', path)
    entries = raw
  } catch (exc) {
    if (!isMissError(exc)) throw exc
    return null
  }
  if (!Array.isArray(entries) || entries.length === 0) return null
  return new FileStat({
    name: gnuBasename(rstripSlash(path.virtual)),
    type: FileType.DIRECTORY,
  })
}

// Stat one virtual path through the workspace, null when absent.
//
// Resolves through the op dispatcher rather than one backend, so a path
// under another mount answers correctly. This is what a traversal command
// asks about its own start point: a directory can be walked, a file is
// reported as itself, and null is GNU's missing-operand error. The
// overlay is applied on the way out for the reason linkTargetStat states:
// Python's dispatcher applies it itself, this one does not.
export async function pathStat(
  dispatch: DispatchFn,
  virtual: string,
  overlay: StatOverlay | null = null,
): Promise<FileStat | null> {
  const spec = PathSpec.fromStrPath(virtual, '')
  const stat = await resolvePathStat(dispatch, spec)
  if (stat === null) return null
  return overlay !== null ? overlay(virtual, stat) : stat
}

// List one virtual path through the workspace, as virtual paths.
//
// Resolves through the op dispatcher rather than one backend, so a
// directory served by another mount answers. This is what a walker reads
// once it crosses a mount boundary: the subtree under a nested mount
// lives in a resource the walker's own accessor cannot open.
export async function pathReaddir(dispatch: DispatchFn, virtual: string): Promise<string[]> {
  const spec = PathSpec.fromStrPath(virtual, '')
  const [entries] = await dispatch('readdir', spec)
  return entries as string[]
}

// Whether a resolved virtual path names something that exists.
export async function pathExists(dispatch: DispatchFn, virtual: string): Promise<boolean> {
  try {
    return (await pathStat(dispatch, virtual)) !== null
  } catch {
    return false
  }
}

// The stat of what a link points at, or null when it dangles.
//
// Under -L the reported entity is the target, so its type drives -type
// and its size and mtime drive -size and -mtime. The stat goes through
// dispatch rather than one backend because a link may point into
// another mount, and through the overlay because the target's mtime may
// be namespace state (touch results, observed writes). Python gets the
// overlay from the ops dispatcher itself; here it is applied on the way
// out, against the resolved path rather than the link's.
export async function linkTargetStat(
  namespace: Namespace,
  dispatch: DispatchFn,
  virtual: string,
  overlay: StatOverlay | null,
): Promise<FileStat | null> {
  let target: string
  try {
    target = namespace.follow(virtual)
  } catch {
    // A loop (ELOOP) is one of the two ways a link legitimately has no
    // target; statOrNull maps the other (missing). Every other backend
    // failure propagates, because a permission or connection error is
    // not a dangling link and reporting it as one would print the link
    // as -type l and exit 0.
    return null
  }
  const stat = await statOrNull(dispatch, PathSpec.fromStrPath(target, ''))
  if (stat === null || overlay === null) return stat
  return overlay(target, stat)
}

// A readlink the door refused (session scope or policy) or answered
// EINVAL (not a link): both land on GNU readlink's silent exit 1.
function readlinkRefused(err: unknown): boolean {
  if (err instanceof PolicyDenied || err instanceof MountNotAllowedError) return true
  return (err as { code?: unknown }).code === 'EINVAL'
}

// Print a symlink's target, GNU readlink semantics.
//
// The three canonicalizing flags differ only in how much of the resolved
// path has to exist: -m requires nothing, -f requires every component
// but the last, and -e requires all of it. A path that falls short
// prints nothing and exits 1.
export async function handleReadlink(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: Session,
  args: (string | PathSpec)[],
): Promise<Result> {
  const [flags, operands] = splitFlags(args, 'fenm')
  if (operands.length === 0) {
    return errorResult('readlink', 'readlink: missing operand\n')
  }
  const canonical = flags.has('f') || flags.has('e') || flags.has('m')
  const lines: string[] = []
  let exitCode = 0
  for (const op of operands) {
    const absOp = abs(op, session.cwd)
    if (canonical) {
      // -f/-e/-m canonicalize: resolve every symlink (including a trailing
      // one) and normalize the path, GNU realpath-style. A link operand
      // still clears the op door first: -m probes nothing, so without
      // this a scoped session read an ungranted link's target out of
      // the resolved path.
      if (namespace.isLink(absOp)) {
        try {
          await dispatch('readlink', PathSpec.fromStrPath(absOp))
        } catch (err) {
          if (!readlinkRefused(err)) throw err
          exitCode = 1
          continue
        }
      }
      let resolved: string
      try {
        resolved = norm(namespace.follow(absOp))
      } catch (err) {
        if (!(err instanceof CycleError)) throw err
        exitCode = 1
        continue
      }
      const probe = flags.has('e')
        ? resolved
        : flags.has('f')
          ? resolved.slice(0, resolved.lastIndexOf('/')) || '/'
          : null
      if (probe !== null && !(await pathExists(dispatch, probe))) {
        exitCode = 1
        continue
      }
      lines.push(resolved)
      continue
    }
    // The link entry is namespace state behind the op door: session
    // grants and admission policies decide whether this session may
    // read the target at all.
    let target: string
    try {
      const [found] = await dispatch('readlink', PathSpec.fromStrPath(absOp))
      target = found as string
    } catch (err) {
      if (!readlinkRefused(err)) throw err
      exitCode = 1
      continue
    }
    lines.push(target)
  }
  if (lines.length === 0) {
    return [null, new IOResult({ exitCode }), new ExecutionNode({ command: 'readlink', exitCode })]
  }
  const text = flags.has('n') ? lines.join('') : lines.map((l) => l + '\n').join('')
  return [
    new TextEncoder().encode(text),
    new IOResult({ exitCode }),
    new ExecutionNode({ command: 'readlink', exitCode }),
  ]
}
